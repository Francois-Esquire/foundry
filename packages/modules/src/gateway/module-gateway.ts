import { z } from "zod";

import type { ModuleCapabilityRequest } from "../manifest";
import type { ModuleStore } from "../store/contract";
import { ModuleGatewayContractError } from "./catalog";
import { loadRuntimeGatewayContext } from "./runtime-context";
import type {
  ModuleCapabilityCatalog,
  ModuleGateway,
  ModuleGatewayBinding,
  ModuleGatewayClose,
  ModuleGatewayDispatchResult,
  ModuleGatewayFailureCode,
  ModuleGatewayHelloFrame,
  ModuleGatewayHostFrame,
  ModuleGatewayInvocationFrame,
  ModuleGatewayProgramFrame,
  ModuleGatewayRuntimeDispatcher,
  ModuleGatewaySession,
  ModuleGatewaySessionMode,
  ModuleRuntimeIdentity,
  ModuleTransport,
} from "./types";
import { ModuleGatewayError } from "./types";

export interface CreateModuleGatewayOptions {
  /**
   * How long a request's provider work may keep running once the request is
   * over (answered, cancelled, or ended by closing), before the Gateway
   * stops waiting for it and reports it abandoned. Defaults to 5 seconds,
   * inside the Program supervisor's teardown observation window.
   */
  readonly cancellationGraceMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly maximumFrameBytes?: number;
  readonly maximumInFlight?: number;
  readonly runtimeDispatcher?: ModuleGatewayRuntimeDispatcher;
  readonly store: ModuleStore;
}

const DEFAULT_CANCELLATION_GRACE_MS = 5000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_MAXIMUM_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAXIMUM_IN_FLIGHT = 32;
/**
 * The v1 protocol rejects duplicate request IDs for the life of a connection,
 * so the set of seen IDs can only grow. Bound the session instead of the
 * guarantee: past this many requests the connection is closed, not forgotten.
 */
const MAXIMUM_SESSION_REQUESTS = 100_000;

/** Creates the host-owned Gateway connection, framing, and session lifecycle. */
export function createModuleGateway(
  options: CreateModuleGatewayOptions
): ModuleGateway {
  const settings = gatewaySettings(options);
  return new DefaultModuleGateway(
    options.store,
    settings,
    options.runtimeDispatcher
  );
}

interface GatewaySettings {
  readonly cancellationGraceMs: number;
  readonly handshakeTimeoutMs: number;
  readonly heartbeatIntervalMs: number;
  readonly maximumFrameBytes: number;
  readonly maximumInFlight: number;
}

class DefaultModuleGateway implements ModuleGateway {
  readonly #sessions = new Map<string, DefaultModuleGatewaySession>();
  readonly #connecting = new Set<string>();

  private readonly store: ModuleStore;
  private readonly settings: GatewaySettings;
  private readonly runtimeDispatcher:
    | ModuleGatewayRuntimeDispatcher
    | undefined;

  constructor(
    store: ModuleStore,
    settings: GatewaySettings,
    runtimeDispatcher: ModuleGatewayRuntimeDispatcher | undefined
  ) {
    this.store = store;
    this.settings = settings;
    this.runtimeDispatcher = runtimeDispatcher;
  }

  async connect(input: {
    readonly runtime: ModuleRuntimeIdentity;
    readonly capabilities: readonly ModuleCapabilityRequest[];
    readonly transport: ModuleTransport;
  }): Promise<ModuleGatewaySession> {
    const context = await loadRuntimeGatewayContext(this.store, input.runtime);
    return this.#connect(
      {
        capabilities: input.capabilities,
        mode: "runtime",
        moduleId: context.installation.moduleId,
        runtime: input.runtime,
      },
      input.transport,
      runtimeSessionKey(input.runtime)
    );
  }

  connectDevelopment(input: {
    readonly developmentId: string;
    readonly catalog: ModuleCapabilityCatalog;
    readonly transport: ModuleTransport;
  }): Promise<ModuleGatewaySession> {
    if (!validIdentity(input.developmentId)) {
      return Promise.reject(
        new ModuleGatewayError(
          "invalid-frame",
          "Gateway development identity must be a bounded non-empty string"
        )
      );
    }
    return this.#connect(
      {
        catalog: input.catalog,
        developmentId: input.developmentId,
        mode: "development",
      },
      input.transport,
      `development:${input.developmentId}`
    );
  }

  async #connect(
    binding: ModuleGatewayBinding,
    transport: ModuleTransport,
    key: string
  ): Promise<ModuleGatewaySession> {
    if (this.#sessions.has(key) || this.#connecting.has(key)) {
      throw new ModuleGatewayError(
        "duplicate-request",
        `Gateway session ${key} already exists`
      );
    }
    this.#connecting.add(key);
    const iterator = transport.incoming[Symbol.asyncIterator]();
    try {
      await sendBounded(transport, helloFrame(binding), this.settings);
      await waitForReady(
        iterator,
        transport.closed,
        binding.mode,
        this.settings.handshakeTimeoutMs
      );
      // The handshake has its own deadline, so re-read the selection the
      // Program just answered for: a lifecycle transition may have superseded
      // this attempt while it waited.
      if (binding.mode === "runtime") {
        await loadRuntimeGatewayContext(this.store, binding.runtime);
      }
      if (binding.mode === "development") {
        await sendBounded(
          transport,
          { catalog: binding.catalog, kind: "catalog.snapshot" },
          this.settings
        );
      }
    } catch (error) {
      await iterator.return?.();
      await closeAfterRejectedHandshake(transport);
      throw error;
    } finally {
      this.#connecting.delete(key);
    }

    const session = new DefaultModuleGatewaySession({
      binding,
      iterator,
      runtimeDispatcher: this.runtimeDispatcher,
      settings: this.settings,
      transport,
    });
    this.#sessions.set(key, session);
    session.closed.then(() => {
      if (this.#sessions.get(key) === session) {
        this.#sessions.delete(key);
      }
    });
    session.observe();
    return session;
  }
}

/**
 * One session's lifecycle:
 * - A request is answered once: its result, its stream's events then
 *   `complete`, or a failure. A cancel is answered at once, while the
 *   provider may still be cleaning up.
 * - The Gateway owns the provider work behind each request until it ends:
 *   the dispatch, a stream result that arrives late, and the cleanup a
 *   stream runs when it stops being read. Once a request is over, that work
 *   has `cancellationGraceMs` to end. Work still running then is abandoned:
 *   the Gateway stops waiting, lists the request in `closed.abandoned`, and
 *   still disposes whatever it produces later, discarding its errors.
 * - Closing is one settlement whoever starts it. It aborts every request,
 *   closes the transport, waits for provider work as above, then resolves
 *   `closed` and every `close()` call (or rejects every call with the
 *   transport's close failure). No frame is sent once it has begun.
 */
class DefaultModuleGatewaySession implements ModuleGatewaySession {
  readonly mode: ModuleGatewaySessionMode;
  readonly closed: Promise<ModuleGatewayClose>;
  readonly #resolveClosed: (close: ModuleGatewayClose) => void;
  readonly #requests = new Map<string, AbortController>();
  /** Every request whose provider work has not ended or been abandoned. */
  readonly #dispatches = new Set<Promise<void>>();
  /** Requests whose provider work outlived the grace, in that order. */
  readonly #abandoned: string[] = [];
  readonly #cancelled = new Set<string>();
  readonly #seenRequestIds = new Set<string>();
  readonly #settings: GatewaySettings;
  readonly #transport: ModuleTransport;
  readonly #iterator: AsyncIterator<unknown>;
  readonly #binding: ModuleGatewayBinding;
  readonly #runtimeDispatcher: ModuleGatewayRuntimeDispatcher | undefined;
  // Widened so lint sees the flag as mutable; async paths set it later.
  #settled = false as boolean;
  #settlement: Promise<void> | undefined;
  #sendTail: Promise<void> = Promise.resolve();
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #heartbeatSequence = 0;
  #missedHeartbeats = 0;

  constructor(input: {
    readonly binding: ModuleGatewayBinding;
    readonly transport: ModuleTransport;
    readonly iterator: AsyncIterator<unknown>;
    readonly settings: GatewaySettings;
    readonly runtimeDispatcher: ModuleGatewayRuntimeDispatcher | undefined;
  }) {
    this.mode = input.binding.mode;
    this.#binding = input.binding;
    this.#transport = input.transport;
    this.#iterator = input.iterator;
    this.#settings = input.settings;
    this.#runtimeDispatcher = input.runtimeDispatcher;
    const closed = Promise.withResolvers<ModuleGatewayClose>();
    this.closed = closed.promise;
    this.#resolveClosed = closed.resolve;
  }

  observe(): void {
    this.#startHeartbeat();
    Promise.race([
      this.#transport.closed.then(() => ({
        code: "transport-closed" as const,
        reason: "Gateway transport closed",
      })),
      this.#observeFrames(),
    ])
      .then((close) => this.#end(close, close.code !== "transport-closed"))
      .catch(() => undefined);
  }

  close(reason: string): Promise<void> {
    return this.#settle(
      { code: "requested", reason: normalizeCloseReason(reason) },
      true
    );
  }

  publishCatalogChange(revision: string): Promise<void> {
    if (this.mode !== "development") {
      return Promise.reject(
        new ModuleGatewayError(
          "invalid-frame",
          "Only development Gateway sessions publish catalog changes"
        )
      );
    }
    if (!validIdentity(revision)) {
      return Promise.reject(
        new ModuleGatewayError(
          "invalid-frame",
          "Gateway catalog revision must be a bounded non-empty string"
        )
      );
    }
    // `#send` drops frames once settled; a caller publishing is told.
    if (this.#settled) {
      return Promise.reject(
        new ModuleGatewayError("transport-closed", "Gateway session closed")
      );
    }
    return this.#send({ kind: "catalog.changed", revision });
  }

  async #observeFrames(): Promise<ModuleGatewayClose> {
    try {
      while (!this.#settled) {
        const next = await this.#iterator.next();
        // Closing may have begun while the read waited; a frame read after
        // that is dropped, so no request is admitted past the abort pass.
        if (this.#settled) {
          break;
        }
        if (next.done === true) {
          return { code: "transport-closed", reason: "Gateway frames ended" };
        }
        const frame = parseProgramFrame(next.value, this.#settings);
        const close = this.#handleFrame(frame);
        if (close !== undefined) {
          return close;
        }
      }
      return { code: "requested", reason: "Gateway session closed" };
    } catch (error) {
      return {
        code:
          error instanceof ModuleGatewayError
            ? "protocol-error"
            : "transport-closed",
        reason: stableMessage(error, "Gateway transport failed"),
      };
    }
  }

  #handleFrame(
    frame: ModuleGatewayProgramFrame
  ): ModuleGatewayClose | undefined {
    if (frame.kind === "heartbeat") {
      if (frame.sequence === this.#heartbeatSequence) {
        this.#missedHeartbeats = 0;
      }
      return undefined;
    }
    if (frame.kind === "shutdown") {
      return { code: "requested", reason: normalizeCloseReason(frame.reason) };
    }
    if (this.mode === "development") {
      throw new ModuleGatewayError(
        "invalid-frame",
        "Development Gateway sessions accept only heartbeat and shutdown frames"
      );
    }
    if (frame.kind === "cancel") {
      this.#cancel(frame.id);
      return undefined;
    }
    if (frame.kind === "invoke") {
      this.#beginInvocation(frame);
      return undefined;
    }
    throw new ModuleGatewayError(
      "invalid-frame",
      "Gateway frame is not accepted"
    );
  }

  #beginInvocation(request: ModuleGatewayInvocationFrame): void {
    if (this.#seenRequestIds.has(request.id)) {
      this.#sendFailure(
        request.id,
        "duplicate-request",
        "Gateway request ID has already been used"
      );
      return;
    }
    if (this.#seenRequestIds.size >= MAXIMUM_SESSION_REQUESTS) {
      this.#end(
        {
          code: "protocol-error",
          reason: "Gateway session exhausted its request ceiling",
        },
        true
      );
      return;
    }
    this.#seenRequestIds.add(request.id);
    if (this.#requests.size >= this.#settings.maximumInFlight) {
      this.#sendFailure(
        request.id,
        "capacity-exceeded",
        "Gateway has reached its in-flight request limit"
      );
      return;
    }
    const controller = new AbortController();
    this.#requests.set(request.id, controller);
    const work: ProviderWork = { ended: false };
    // A failed answer settles the session at once, without waiting for the
    // provider work behind it.
    const answered = this.#dispatch(request, controller, work).catch(() =>
      this.#sendFailed()
    );
    const dispatch = answered
      .then(() => this.#release(request.id, controller, work))
      .finally(() => {
        this.#requests.delete(request.id);
        this.#cancelled.delete(request.id);
        this.#dispatches.delete(dispatch);
      });
    this.#dispatches.add(dispatch);
  }

  /**
   * An answer rejects only when its last frame could not be sent, which
   * means the transport failed under an open session.
   */
  #sendFailed(): void {
    if (!this.#settled) {
      this.#end(
        { code: "transport-closed", reason: "Gateway transport failed" },
        true
      );
    }
  }

  /**
   * Waits, within the grace, for the provider work behind an answered
   * request to end. Nobody reads it any more, so it is told to stop first.
   */
  async #release(
    id: string,
    controller: AbortController,
    work: ProviderWork
  ): Promise<void> {
    if (work.ended) {
      return;
    }
    controller.abort();
    const ended = await within(
      endProviderWork(work),
      this.#settings.cancellationGraceMs
    );
    if (!ended) {
      this.#abandoned.push(id);
    }
  }

  /**
   * Answers one request. Waits for provider work only while it answers;
   * whatever is still running afterwards is recorded in `work`.
   */
  async #dispatch(
    request: ModuleGatewayInvocationFrame,
    controller: AbortController,
    work: ProviderWork
  ): Promise<void> {
    const binding =
      this.#binding.mode === "runtime" ? this.#binding : undefined;
    if (binding === undefined || this.#runtimeDispatcher === undefined) {
      work.ended = true;
      await this.#sendFailure(
        request.id,
        "unknown-capability",
        "No capability dispatcher is available for this Gateway session"
      );
      return;
    }
    try {
      work.dispatched = this.#runtimeDispatcher.dispatch({
        capabilities: binding.capabilities,
        request,
        runtime: binding.runtime,
        signal: controller.signal,
      });
      const result = await unlessAborted(work.dispatched, controller.signal);
      if (result.mode === "unary") {
        work.ended = true;
      }
      if (this.#cancelled.has(request.id)) {
        await this.#sendFailure(
          request.id,
          "cancelled",
          "Gateway request was cancelled"
        );
        return;
      }
      if (result.mode !== request.mode) {
        await this.#sendFailure(
          request.id,
          "invalid-output",
          "Capability response mode did not match request"
        );
        return;
      }
      if (result.mode === "unary") {
        await this.#send({
          id: request.id,
          kind: "result",
          output: result.output,
        });
        return;
      }
      const events = result.events[Symbol.asyncIterator]();
      work.events = events;
      for (;;) {
        work.reading = events.next();
        const next = await unlessAborted(work.reading, controller.signal);
        work.reading = undefined;
        if (next.done === true) {
          work.ended = true;
          break;
        }
        if (this.#cancelled.has(request.id)) {
          await this.#sendFailure(
            request.id,
            "cancelled",
            "Gateway request was cancelled"
          );
          return;
        }
        await this.#send({ event: next.value, id: request.id, kind: "next" });
      }
      await this.#send({ id: request.id, kind: "complete" });
    } catch (error) {
      if (error instanceof ModuleGatewayError) {
        await this.#sendFailure(request.id, error.code, error.message);
        return;
      }
      await this.#sendFailure(
        request.id,
        controller.signal.aborted ? "cancelled" : "provider-failure",
        controller.signal.aborted
          ? "Gateway request was cancelled"
          : "Gateway provider failed"
      );
    }
  }

  #cancel(id: string): void {
    const request = this.#requests.get(id);
    if (request === undefined || this.#cancelled.has(id)) {
      return;
    }
    this.#cancelled.add(id);
    request.abort();
  }

  #startHeartbeat(): void {
    this.#heartbeatTimer = setInterval(() => {
      if (this.#settled) {
        return;
      }
      if (this.#missedHeartbeats >= 2) {
        this.#end(
          { code: "protocol-error", reason: "Gateway heartbeat timed out" },
          true
        );
        return;
      }
      this.#missedHeartbeats += 1;
      this.#heartbeatSequence += 1;
      // A heartbeat that cannot be sent counts as missed.
      this.#send({
        kind: "heartbeat",
        sequence: this.#heartbeatSequence,
      }).catch(() => undefined);
    }, this.#settings.heartbeatIntervalMs);
  }

  /**
   * Sends in order. Once the session settles, frames are dropped instead:
   * the transport is closing, and a request aborted by settling has nobody
   * left to answer.
   */
  #send(frame: ModuleGatewayHostFrame): Promise<void> {
    if (this.#settled) {
      return Promise.resolve();
    }
    const send = this.#sendTail.then(() =>
      this.#settled
        ? undefined
        : sendBounded(this.#transport, frame, this.#settings)
    );
    this.#sendTail = send.catch(() => undefined);
    return send;
  }

  #sendFailure(
    id: string,
    code: ModuleGatewayFailureCode,
    message: string
  ): Promise<void> {
    return this.#send({ code, id, kind: "failure", message });
  }

  /** Settles the session for the Gateway itself, which has nobody to tell. */
  #end(close: ModuleGatewayClose, closeTransport: boolean): void {
    this.#settle(close, closeTransport).catch(() => undefined);
  }

  /**
   * The one settlement: whoever calls first chooses the close record, and
   * every call, before or after, gets the same promise. A transport whose
   * `close` calls back in gets that pending promise; it must not wait for
   * it, since the settlement is waiting for the transport.
   */
  #settle(close: ModuleGatewayClose, closeTransport: boolean): Promise<void> {
    if (this.#settlement === undefined) {
      const settlement = Promise.withResolvers<void>();
      this.#settlement = settlement.promise;
      this.#settled = true;
      this.#teardown(close, closeTransport).then(
        settlement.resolve,
        settlement.reject
      );
    }
    return this.#settlement;
  }

  async #teardown(
    close: ModuleGatewayClose,
    closeTransport: boolean
  ): Promise<void> {
    if (this.#heartbeatTimer !== undefined) {
      clearInterval(this.#heartbeatTimer);
    }
    for (const request of this.#requests.values()) {
      request.abort();
    }
    this.#requests.clear();
    let failure: unknown;
    try {
      await this.#iterator.return?.();
    } catch (error) {
      failure = error;
    }
    if (closeTransport) {
      try {
        await this.#transport.close(close.reason);
      } catch (error) {
        failure ??= error;
      }
    }
    // Each request's provider work ends or is abandoned within the grace.
    await Promise.allSettled(this.#dispatches);
    this.#resolveClosed(
      Object.freeze(
        this.#abandoned.length === 0
          ? close
          : { ...close, abandoned: Object.freeze([...this.#abandoned]) }
      )
    );
    if (failure instanceof Error) {
      throw failure;
    }
    if (failure !== undefined) {
      throw new ModuleGatewayError(
        "transport-closed",
        "Gateway transport cleanup failed"
      );
    }
  }
}

/**
 * The provider work behind one request, as far as the Gateway has seen it.
 * `ended` means nothing of it can still be running.
 */
interface ProviderWork {
  dispatched?: Promise<ModuleGatewayDispatchResult>;
  ended: boolean;
  events?: AsyncIterator<unknown>;
  /** The stream's next event, asked for and not yet read. */
  reading?: Promise<IteratorResult<unknown>>;
}

/**
 * Ends provider work nobody reads: waits for its dispatch, then stops its
 * stream, waiting for the provider's cleanup. A stream that arrives late is
 * disposed unread. The request was already answered, so provider failures
 * here have nobody to go to; the runtime dispatcher records them.
 */
async function endProviderWork(work: ProviderWork): Promise<void> {
  let result: ModuleGatewayDispatchResult | undefined;
  try {
    result = await work.dispatched;
  } catch {
    return;
  }
  if (result?.mode !== "stream") {
    return;
  }
  const events = work.events ?? result.events[Symbol.asyncIterator]();
  // A stream still producing an event answers `return` once that is done.
  await Promise.allSettled([
    work.reading,
    Promise.resolve().then(() => events.return?.()),
  ]);
}

/** Whether `work` settles within `ms`. Stops waiting, not the work. */
async function within(work: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}

function gatewaySettings(options: CreateModuleGatewayOptions): GatewaySettings {
  const settings = {
    cancellationGraceMs:
      options.cancellationGraceMs ?? DEFAULT_CANCELLATION_GRACE_MS,
    handshakeTimeoutMs:
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    heartbeatIntervalMs:
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    maximumFrameBytes: options.maximumFrameBytes ?? DEFAULT_MAXIMUM_FRAME_BYTES,
    maximumInFlight: options.maximumInFlight ?? DEFAULT_MAXIMUM_IN_FLIGHT,
  };
  for (const [name, value] of Object.entries(settings)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ModuleGatewayContractError(
        `Gateway ${name} must be a positive safe integer`
      );
    }
  }
  return Object.freeze(settings);
}

function helloFrame(binding: ModuleGatewayBinding): ModuleGatewayHelloFrame {
  if (binding.mode === "development") {
    return Object.freeze({
      binding: { developmentId: binding.developmentId },
      kind: "hello",
      mode: "development",
      protocol: 1,
    });
  }
  const { runtime } = binding;
  return Object.freeze({
    binding: {
      generation: runtime.generation,
      installationId: runtime.installationId,
      moduleId: binding.moduleId,
      // Protocol 1 names the pinned Content `releaseId` on the wire.
      releaseId: runtime.contentId,
      runtimeInstanceId: runtime.runtimeInstanceId,
    },
    kind: "hello",
    mode: "runtime",
    protocol: 1,
  });
}

async function waitForReady(
  iterator: AsyncIterator<unknown>,
  transportClosed: Promise<void>,
  mode: ModuleGatewaySessionMode,
  timeoutMs: number
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const frame = await Promise.race([
      iterator.next(),
      transportClosed.then(() => {
        throw new ModuleGatewayError(
          "transport-closed",
          "Gateway transport closed before Program readiness"
        );
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(
            new ModuleGatewayError(
              "timeout",
              "Program did not complete the Gateway handshake in time"
            )
          );
        }, timeoutMs);
      }),
    ]);
    if (frame.done === true || !isReadyFrame(frame.value, mode)) {
      throw new ModuleGatewayError(
        "incompatible-protocol",
        "Program must open the Gateway with matching ready protocol and mode"
      );
    }
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

/** Program frames are exact: an unexpected member fails the frame closed. */
const identitySchema = z.string().min(1).max(256);
const readyFrameSchema = z.strictObject({
  kind: z.literal("ready"),
  mode: z.enum(["development", "runtime"]),
  protocol: z.literal(1),
});
const programFrameSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("heartbeat"),
    sequence: z.int().positive(),
  }),
  z.strictObject({ kind: z.literal("shutdown"), reason: z.string() }),
  z.strictObject({ id: identitySchema, kind: z.literal("cancel") }),
  z.strictObject({
    alias: identitySchema,
    id: identitySchema,
    input: z.unknown(),
    kind: z.literal("invoke"),
    mode: z.enum(["unary", "stream"]),
  }),
]);

function parseProgramFrame(
  value: unknown,
  settings: GatewaySettings
): ModuleGatewayProgramFrame {
  assertFrameSize(value, settings);
  const result = programFrameSchema.safeParse(value);
  if (!result.success) {
    throw new ModuleGatewayError(
      "invalid-frame",
      result.error.issues.some((issue) => issue.path.length === 0)
        ? "Gateway frame must be an object"
        : "Gateway frame shape is invalid"
    );
  }
  // `input` carries any JSON value, so its absence has to be rejected here
  // rather than by the schema, which cannot tell missing from undefined.
  if (result.data.kind === "invoke" && !declaresInput(value)) {
    throw new ModuleGatewayError(
      "invalid-frame",
      "Gateway frame shape is invalid"
    );
  }
  return result.data;
}

function declaresInput(value: unknown): boolean {
  return typeof value === "object" && value !== null && "input" in value;
}

function isReadyFrame(value: unknown, mode: ModuleGatewaySessionMode): boolean {
  const result = readyFrameSchema.safeParse(value);
  return result.success && result.data.mode === mode;
}

function assertFrameSize(value: unknown, settings: GatewaySettings): void {
  const bytes = encodedFrameBytes(value);
  if (bytes > settings.maximumFrameBytes) {
    throw new ModuleGatewayError(
      "capacity-exceeded",
      "Gateway frame exceeds the configured byte limit"
    );
  }
}

async function sendBounded(
  transport: ModuleTransport,
  frame: ModuleGatewayHostFrame,
  settings: GatewaySettings
): Promise<void> {
  assertFrameSize(frame, settings);
  await transport.send(frame);
}

function encodedFrameBytes(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string") {
      throw new Error("not JSON");
    }
    return new TextEncoder().encode(encoded).byteLength;
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: ModuleGatewayError accepts ErrorOptions as its third argument.
    throw new ModuleGatewayError(
      "invalid-frame",
      "Gateway frame must be JSON serializable",
      { cause }
    );
  }
}

async function closeAfterRejectedHandshake(
  transport: ModuleTransport
): Promise<void> {
  try {
    await transport.close("Gateway handshake rejected");
  } catch {
    // The original handshake failure remains authoritative.
  }
}

function runtimeSessionKey(runtime: ModuleRuntimeIdentity): string {
  return `runtime:${runtime.runtimeInstanceId}`;
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function normalizeCloseReason(reason: string): string {
  const normalized = reason.trim();
  return normalized.length === 0
    ? "Gateway session closed"
    : normalized.slice(0, 256);
}

/**
 * Settles with `work`, or rejects as cancelled once `signal` aborts, so a
 * dispatcher or stream that ignores the abort cannot hold a request open.
 */
function unlessAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      reject(
        new ModuleGatewayError("cancelled", "Gateway request was cancelled")
      );
    };
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

function stableMessage(error: unknown, fallback: string): string {
  return error instanceof ModuleGatewayError ? error.message : fallback;
}
