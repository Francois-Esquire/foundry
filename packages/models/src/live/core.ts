import { modelErrors } from "../errors";
import { getFalRuntime } from "../fal/client";
import type { InputForm, Media } from "../types";
import { credentialUnavailable } from "./fal-access";
import type {
  Connect,
  Transport,
  TransportHandlers,
  TransportMedia,
  TransportSend,
} from "./transport";
import type {
  LiveAccess,
  LiveClosedReason,
  LiveDirection,
  LiveOptions,
  LiveState,
  LiveTarget,
} from "./types";

/**
 * Where the received media of a `continuous` session goes. The browser entry
 * routes it to `onStream`, the Node entry to `onTrack` and `tracks`; the core
 * never names either media type.
 */
export interface HostAdapter {
  data(raw: string): void;
  media(media: TransportMedia, direction: number): void;
}

export interface CoreRequest {
  readonly access: LiveAccess;
  readonly adapter: HostAdapter;
  readonly connect: { readonly socket: Connect; readonly webrtc: Connect };
  readonly options: LiveOptions & { readonly feed?: unknown };
  readonly peerConnectionFactory?: (configuration: unknown) => unknown;
  readonly target: LiveTarget;
}

/** How many correlations to remember before the oldest unanswered ones age out. */
const CORRELATION_LIMIT = 64;

export class LiveCore {
  #state: LiveState = "open";
  #sequence = 1;
  #direction: LiveDirection;
  #directionDirty = false;
  #pendingFrame: { frame: Media; id?: string } | null = null;
  #references: readonly Media[] | undefined;
  #referencesDirty = false;
  #inFlight = false;
  #lastSendAt = 0;
  #throttleTimer: ReturnType<typeof setTimeout> | null = null;
  #expiryTimer: ReturnType<typeof setTimeout> | null = null;
  #closedFired = false;
  #correlations = new Map<string, { sequence: number; id?: string }>();
  #lastSentSequence = 1;
  #nextCorrelation = 0;
  #teardowns: (() => void)[] = [];

  readonly #transport: Transport;
  readonly #options: LiveOptions;
  readonly #adapter: HostAdapter;
  readonly #inputs: readonly InputForm[];

  constructor(
    transport: Transport,
    request: CoreRequest,
    inputs: readonly InputForm[]
  ) {
    this.#transport = transport;
    this.#options = request.options;
    this.#adapter = request.adapter;
    this.#inputs = inputs;
    this.#direction = request.options.direction;
    this.#references = request.options.references;
  }

  get state(): LiveState {
    return this.#state;
  }

  get direction(): number {
    return this.#sequence;
  }

  /** Runs before the transport is released. Used by `record` to stop cleanly. */
  addTeardown(teardown: () => void): void {
    this.#teardowns.push(teardown);
  }

  direct(direction: LiveDirection): number {
    if (this.#state !== "open") {
      this.#refuse("direction", "the interaction is no longer open");
      return this.#sequence;
    }
    this.#direction = direction;
    this.#sequence += 1;
    this.#directionDirty = true;
    this.#flush();
    return this.#sequence;
  }

  reference(media: readonly Media[]): void {
    if (this.#state !== "open") {
      this.#refuse("reference-media", "the interaction is no longer open");
      return;
    }
    if (!this.#inputs.includes("reference-media")) {
      this.#refuse(
        "reference-media",
        "this Model does not accept reference media"
      );
      return;
    }
    this.#references = media;
    this.#referencesDirty = true;
    this.#flush();
  }

  supply(frame: Media, id?: string): void {
    if (this.#state !== "open") {
      this.#refuse("frame", "the interaction is no longer open");
      return;
    }
    if (!this.#inputs.includes("frame")) {
      this.#refuse("frame", "this Model does not accept frames");
      return;
    }
    this.#pendingFrame = { frame, id };
    this.#flush();
  }

  refuse(input: InputForm, reason: string): void {
    this.#refuse(input, reason);
  }

  close(): void {
    this.#terminate("closed", "closed");
  }

  /** Wired to the transport's handlers by `openCore`. */
  handlers(): TransportHandlers {
    return {
      close: (reason, message) => {
        this.#terminate("disconnected", reason, message);
      },
      data: (raw) => {
        if (this.#state !== "open") {
          return;
        }
        this.#adapter.data(raw);
      },
      error: () => {
        // A transport error that is not a loss of the session is not a state
        // change; the transports report loss through `close`.
      },
      media: (media) => {
        if (this.#state !== "open") {
          return;
        }
        this.#adapter.media(media, this.#sequence);
      },
      message: (message) => {
        if (this.#state !== "open") {
          return;
        }
        const echoed =
          message.correlation === undefined
            ? undefined
            : this.#correlations.get(message.correlation);
        if (message.correlation !== undefined) {
          this.#correlations.delete(message.correlation);
        }
        this.#options.onResult?.({
          // Committed time, not delivery time: the sequence the echoed send
          // carried, or — for a transport that echoes nothing — the sequence
          // the most recent accepted input carried. The fallback is dead on
          // every transport that ships here: the socket path echoes
          // `request_id`, and the continuous path delivers media rather than
          // messages. It exists for a transport with no echo field, and is
          // still committed-time rather than latest-at-delivery.
          direction: echoed?.sequence ?? this.#lastSentSequence,
          media: message.media,
          ...(echoed?.id === undefined ? {} : { input: echoed.id }),
        });
      },
    };
  }

  armExpiry(expiresAt: number): void {
    this.#expiryTimer = setTimeout(
      () => {
        this.#terminate("disconnected", "expired");
      },
      Math.max(0, expiresAt - Date.now())
    );
  }

  /** The opening send. Its rejection is an `open` failure, not a state change. */
  async prime(): Promise<void> {
    this.#lastSendAt = Date.now();
    await this.#transport.send(this.#next({}));
  }

  #refuse(input: InputForm, reason: string): void {
    this.#options.onRefused?.(input, reason);
  }

  #next(part: { frame?: Media; frameId?: string }): TransportSend {
    this.#nextCorrelation += 1;
    const correlation = `d${String(this.#nextCorrelation)}`;
    this.#correlations.set(correlation, {
      sequence: this.#sequence,
      ...(part.frameId === undefined ? {} : { id: part.frameId }),
    });
    while (this.#correlations.size > CORRELATION_LIMIT) {
      const oldest = this.#correlations.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.#correlations.delete(oldest.value);
    }
    this.#lastSentSequence = this.#sequence;
    return {
      correlation,
      direction: this.#direction,
      ...(this.#references === undefined
        ? {}
        : { references: this.#references }),
      ...(part.frame === undefined ? {} : { frame: part.frame }),
      ...(part.frameId === undefined ? {} : { frameId: part.frameId }),
    };
  }

  #flush(): void {
    if (this.#state !== "open" || this.#inFlight) {
      return;
    }
    if (
      this.#pendingFrame === null &&
      !this.#directionDirty &&
      !this.#referencesDirty
    ) {
      return;
    }
    const throttleMs = this.#options.throttleMs ?? 0;
    const wait = throttleMs - (Date.now() - this.#lastSendAt);
    if (throttleMs > 0 && wait > 0) {
      if (this.#throttleTimer === null) {
        this.#throttleTimer = setTimeout(() => {
          this.#throttleTimer = null;
          this.#flush();
        }, wait);
      }
      return;
    }
    const frame = this.#pendingFrame;
    this.#pendingFrame = null;
    this.#directionDirty = false;
    this.#referencesDirty = false;
    this.#inFlight = true;
    this.#lastSendAt = Date.now();
    void this.#transport
      .send(
        this.#next(
          frame === null
            ? {}
            : {
                frame: frame.frame,
                ...(frame.id === undefined ? {} : { frameId: frame.id }),
              }
        )
      )
      .catch(() => {
        // Delivery failure is the transport's to report through `close`.
      })
      .finally(() => {
        this.#inFlight = false;
        this.#lastSendAt = Date.now();
        this.#flush();
      });
  }

  #terminate(
    state: Exclude<LiveState, "open">,
    reason: LiveClosedReason,
    message?: string
  ): void {
    if (this.#closedFired) {
      return;
    }
    this.#closedFired = true;
    this.#state = state;
    this.#pendingFrame = null;
    if (this.#throttleTimer !== null) {
      clearTimeout(this.#throttleTimer);
    }
    if (this.#expiryTimer !== null) {
      clearTimeout(this.#expiryTimer);
    }
    this.#throttleTimer = null;
    this.#expiryTimer = null;
    for (const teardown of this.#teardowns.splice(0)) {
      teardown();
    }
    this.#transport.close();
    this.#options.onClosed?.(reason, message);
  }
}

/**
 * Everything `open` shares between the two entries: the fact checks, the
 * transport choice, the opening send, and the state machine. Each entry wraps
 * the returned core in its own host-shaped interaction.
 */
export async function openCore(request: CoreRequest): Promise<LiveCore> {
  const { fact } = request.target;
  if (fact.mode !== "live") {
    throw modelErrors.LIVE_OPEN_REFUSED({
      reason: `${request.target.modelId} has no live fact for ${request.target.operation}; its fact is mode "${fact.mode}"`,
    });
  }
  if (fact.operation !== request.target.operation) {
    throw modelErrors.LIVE_OPEN_REFUSED({
      reason: `the fact supplied for ${request.target.operation} declares operation "${fact.operation}"`,
    });
  }
  if (
    request.access.kind === "token" &&
    request.access.expiresAt <= Date.now()
  ) {
    throw modelErrors.LIVE_ACCESS_UNAVAILABLE({
      reason: "the supplied access token has expired",
    });
  }
  // Prechecked here as well as in the transport, so a refused `credential`
  // never reaches a connect at all.
  if (request.access.kind === "credential" && getFalRuntime() === null) {
    throw credentialUnavailable();
  }
  if (request.options.feed !== undefined && !fact.inputs.includes("feed")) {
    throw modelErrors.LIVE_OPEN_REFUSED({
      reason: `${request.target.modelId} does not accept a feed for ${request.target.operation}`,
    });
  }
  if (
    fact.delivery === "continuous" &&
    fact.required.includes("feed") &&
    request.options.feed === undefined
  ) {
    throw modelErrors.LIVE_OPEN_REFUSED({
      reason: `${request.target.modelId} requires a feed at open for ${request.target.operation}`,
    });
  }
  // The fact fixes the transport; no host, runtime, or environment check.
  const connect =
    fact.delivery === "continuous"
      ? request.connect.webrtc
      : fact.delivery === "result-per-input"
        ? request.connect.socket
        : null;
  if (connect === null) {
    throw modelErrors.LIVE_OPEN_REFUSED({
      reason: `delivery "${fact.delivery}" is not a live transport`,
    });
  }

  let core: LiveCore | null = null;
  const transport = await connect(
    request.target,
    request.access,
    {
      direction: request.options.direction,
      ...(request.options.feed === undefined
        ? {}
        : { feed: request.options.feed }),
      ...(request.options.throttleMs === undefined
        ? {}
        : { throttleMs: request.options.throttleMs }),
      ...(request.peerConnectionFactory === undefined
        ? {}
        : { peerConnectionFactory: request.peerConnectionFactory }),
    },
    {
      close: (reason, message) => core?.handlers().close(reason, message),
      data: (raw) => core?.handlers().data(raw),
      error: (error) => core?.handlers().error(error),
      media: (media) => core?.handlers().media(media),
      message: (message) => core?.handlers().message(message),
    }
  );
  core = new LiveCore(transport, request, fact.inputs);
  try {
    await core.prime();
  } catch (error) {
    transport.close();
    throw error;
  }
  if (request.access.kind === "token") {
    core.armExpiry(request.access.expiresAt);
  }
  return core;
}
