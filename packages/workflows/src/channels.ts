import { Effect, Exit, Option, PubSub, Scope, Stream } from "effect";

import { MessageLog } from "./channel-log";

import type { JsonValue } from "./json-value";
import type { ChannelEvent, ErrorShape, SuspensionState } from "./schema";
import {
  CustomEvent,
  StepAbortedEvent,
  StepBailedEvent,
  StepCompleteEvent,
  StepFailedEvent,
  StepPausedEvent,
  StepProgressEvent,
  StepResumedEvent,
  StepSkippedEvent,
  StepStartedEvent,
  StepSuspendedEvent,
} from "./schema";
import type { SnapshotState, StepStatus } from "./snapshot";
import { Snapshot } from "./snapshot";
import type { LogCallback, TelemetryLogEntry } from "./telemetry";

/**
 * Streaming broadcast hub. Three interfaces: `events` (lifecycle + custom
 * events; applies to Snapshot before broadcast), `chunks` (typed output),
 * `stream` (unified ReadableStream). Each supports `publish` (Effect) and
 * `push` (sync) writes. Events update Snapshot synchronously; subscribers
 * see eventual consistency. Scope-managed.
 */

export type { ChannelEvent, SuspensionState } from "./schema";

/** Input accepted by Step suspension while legacy `meta` remains supported. */
export interface SuspensionRequest {
  readonly kind?: string;
  readonly meta?: Record<string, unknown>;
  readonly name: string;
  readonly reason: string;
  readonly request?: JsonValue;
}

// ── Other message types ──

/** Chunk payload: text or data. */
export type ChunkPayload<S = unknown> =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "data"; readonly data: S };

/** A chunk from a step's output stream. */
export interface ChannelChunk<S = unknown> {
  readonly at: string;
  /** The writing step's path; unlike `stepId`, unique within the run. */
  readonly path: readonly string[];
  readonly payload: ChunkPayload<S>;
  /** The writing step's name. */
  readonly stepId: string;
}

export type ChannelMessage<S = unknown> =
  | { readonly _tag: "event"; readonly event: ChannelEvent }
  | { readonly _tag: "chunk"; readonly chunk: ChannelChunk<S> };

// ── PubSubChannel ──

export interface PubSubChannel<A> {
  /** @internal Effect-typed write. */
  readonly publish: (a: A) => Effect.Effect<void>;
  /** @internal Raw PubSub. */
  readonly pubsub: PubSub.PubSub<A>;
  /** Sync write. */
  readonly push: (a: A) => void;
  /** @internal Effect Stream. */
  readonly stream: Stream.Stream<A>;
}

// ── Channels ──

export class Channels<S = unknown> {
  readonly events: PubSubChannel<ChannelEvent>;
  readonly chunks: PubSubChannel<ChannelChunk<S>>;
  /** Unified ReadableStream of events and chunks. */
  readonly stream: ReadableStream<ChannelMessage<S>>;
  readonly #log: MessageLog<ChannelMessage<S>>;
  /** Live Snapshot this Channels projects into — single source of status. */
  readonly #snapshot: Snapshot;
  /**
   * Run-level log sink callback. Set once by the Workflow on the root
   * Channels; shared with the whole tree because `fork()` returns `this`.
   * Granular step logs (`ctx.log`) route here.
   */
  #onLog: LogCallback | undefined;
  #onProgress: ((value: number, path: readonly string[]) => void) | undefined;

  private constructor(args: {
    events: PubSubChannel<ChannelEvent>;
    chunks: PubSubChannel<ChannelChunk<S>>;
    stream: ReadableStream<ChannelMessage<S>>;
    snapshot: Snapshot;
    log: MessageLog<ChannelMessage<S>>;
  }) {
    this.events = args.events;
    this.chunks = args.chunks;
    this.stream = args.stream;
    this.#log = args.log;
    this.#snapshot = args.snapshot;
  }

  /** Install the run-level log callback (Workflow wires this on the root). */
  setLogCallback(onLog: LogCallback): void {
    this.#onLog = onLog;
  }

  /** Install the run-level progress callback used by durable observation. */
  setProgressCallback(
    onProgress: (value: number, path: readonly string[]) => void
  ): void {
    this.#onProgress = onProgress;
  }

  /** Route a granular log line to the run's log callback, if installed. */
  emitLog(entry: TelemetryLogEntry): void {
    this.#onLog?.(entry);
  }

  /**
   * Allocate Channels bound to a Snapshot. Events apply to Snapshot
   * synchronously before broadcast, preserving "publish, then read"
   * in a single fiber.
   *
   * @internal Effect-typed factory. Consumers receive Channels via Step/Workflow.
   */
  static make<Chunk = unknown>(
    snapshot: Snapshot
  ): Effect.Effect<Channels<Chunk>, never, Scope.Scope> {
    return Effect.gen(function* () {
      const eventsPubSub = yield* Effect.acquireRelease(
        PubSub.unbounded<ChannelEvent>(),
        (h) => PubSub.shutdown(h)
      );
      const chunksPubSub = yield* Effect.acquireRelease(
        PubSub.unbounded<ChannelChunk<Chunk>>(),
        (h) => PubSub.shutdown(h)
      );

      // events: Snapshot bridge — apply first, broadcast second.
      const events: PubSubChannel<ChannelEvent> = {
        publish: (event) =>
          Effect.gen(function* () {
            yield* snapshot.applyEventEffect(event);
            yield* PubSub.publish(eventsPubSub, event);
          }),
        pubsub: eventsPubSub,
        push: (event) => {
          snapshot.applyEvent(event);
          Effect.runSync(PubSub.publish(eventsPubSub, event));
        },
        stream: Stream.fromPubSub(eventsPubSub),
      };

      const chunks: PubSubChannel<ChannelChunk<Chunk>> = {
        publish: (chunk) => PubSub.publish(chunksPubSub, chunk),
        pubsub: chunksPubSub,
        push: (chunk) => Effect.runSync(PubSub.publish(chunksPubSub, chunk)),
        stream: Stream.fromPubSub(chunksPubSub),
      };

      // Native multiplexer — buffers until the ReadableStream's
      // controller exists, then enqueues directly. Scope finalizer
      // closes the controller so consumers see EOF on scope close.
      let controller: ReadableStreamDefaultController<
        ChannelMessage<Chunk>
      > | null = null;
      let closed = false;
      const buffer: ChannelMessage<Chunk>[] = [];
      const log = new MessageLog<ChannelMessage<Chunk>>();

      const enqueue = (msg: ChannelMessage<Chunk>): void => {
        if (closed) {
          return;
        }
        log.record(msg);
        if (controller) {
          try {
            controller.enqueue(msg);
          } catch {
            /* downstream cancelled */
          }
        } else {
          buffer.push(msg);
        }
      };

      yield* Effect.forkScoped(
        Stream.runForEach(events.stream, (event) =>
          Effect.sync(() => {
            enqueue({ _tag: "event", event });
          })
        )
      );
      yield* Effect.forkScoped(
        Stream.runForEach(chunks.stream, (chunk) =>
          Effect.sync(() => {
            enqueue({ _tag: "chunk", chunk });
          })
        )
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true;
          log.close();
          if (controller) {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        })
      );

      const stream = new ReadableStream<ChannelMessage<Chunk>>({
        start(c) {
          controller = c;
          for (const msg of buffer) {
            try {
              c.enqueue(msg);
            } catch {
              /* downstream cancelled */
            }
          }
          buffer.length = 0;
          if (closed) {
            try {
              c.close();
            } catch {
              /* already closed */
            }
          }
        },
      });

      return new Channels<Chunk>({ chunks, events, log, snapshot, stream });
    });
  }

  /** Returns this (shared per Run). */
  fork(): this {
    return this;
  }

  /**
   * A fresh stream of every event and chunk in the run: history first, then
   * live, ending when the run's scope closes. Any number may be open, unlike
   * the single-reader {@link stream}.
   */
  subscribe(signal?: AbortSignal): ReadableStream<ChannelMessage<S>> {
    return this.#log.subscribe(signal);
  }

  // ── Event emitters ──
  // Callers pass variable fields; the helper fills `at` at push time.

  /** Common lifecycle envelope: `{ path, name, attempt, at }`. */
  #base(
    path: readonly string[],
    name: string,
    attempt: number
  ): { path: readonly string[]; name: string; attempt: number; at: string } {
    return { at: new Date().toISOString(), attempt, name, path };
  }

  /** Push `step.started`. */
  started(path: readonly string[], name: string, attempt: number): void {
    this.events.push(
      StepStartedEvent.parse({
        _tag: "step.started",
        ...this.#base(path, name, attempt),
      })
    );
  }

  /** Push `step.complete`. */
  complete(
    path: readonly string[],
    name: string,
    attempt: number,
    value: unknown
  ): void {
    this.events.push(
      StepCompleteEvent.parse({
        _tag: "step.complete",
        ...this.#base(path, name, attempt),
        value,
      })
    );
  }

  /** Push `step.failed`. */
  failed(
    path: readonly string[],
    name: string,
    attempt: number,
    error: ErrorShape
  ): void {
    this.events.push(
      StepFailedEvent.parse({
        _tag: "step.failed",
        ...this.#base(path, name, attempt),
        error,
      })
    );
  }

  /** Push `step.bailed`. */
  bailed(
    path: readonly string[],
    name: string,
    attempt: number,
    bail: unknown
  ): void {
    this.events.push(
      StepBailedEvent.parse({
        _tag: "step.bailed",
        ...this.#base(path, name, attempt),
        bail,
      })
    );
  }

  /** Push `step.suspended`. */
  suspended(
    path: readonly string[],
    name: string,
    attempt: number,
    suspension: SuspensionState
  ): void {
    this.events.push(
      StepSuspendedEvent.parse({
        _tag: "step.suspended",
        ...this.#base(path, name, attempt),
        suspension,
      })
    );
  }

  /** Push `step.paused`. */
  paused(
    path: readonly string[],
    name: string,
    attempt: number,
    reason?: string
  ): void {
    this.events.push(
      StepPausedEvent.parse({
        _tag: "step.paused",
        ...this.#base(path, name, attempt),
        ...(reason === undefined ? {} : { reason }),
      })
    );
  }

  /** Push `step.resumed`. */
  resumed(path: readonly string[], name: string, attempt: number): void {
    this.events.push(
      StepResumedEvent.parse({
        _tag: "step.resumed",
        ...this.#base(path, name, attempt),
      })
    );
  }

  /** Push `step.skipped`. */
  skipped(
    path: readonly string[],
    name: string,
    attempt: number,
    reason?: string
  ): void {
    this.events.push(
      StepSkippedEvent.parse({
        _tag: "step.skipped",
        ...this.#base(path, name, attempt),
        ...(reason === undefined ? {} : { reason }),
      })
    );
  }

  /** Push `step.aborted`. */
  aborted(
    path: readonly string[],
    name: string,
    attempt: number,
    reason?: unknown
  ): void {
    this.events.push(
      StepAbortedEvent.parse({
        _tag: "step.aborted",
        ...this.#base(path, name, attempt),
        ...(reason === undefined ? {} : { reason }),
      })
    );
  }

  /** Push `step.progress`. */
  progress(
    path: readonly string[],
    name: string,
    attempt: number,
    value: number
  ): void {
    this.events.push(
      StepProgressEvent.parse({
        _tag: "step.progress",
        ...this.#base(path, name, attempt),
        value,
      })
    );
    this.#onProgress?.(value, path);
  }

  /** Push a `custom` event under `path`. */
  custom(
    type: string,
    stepId: string,
    path: readonly string[],
    payload?: unknown
  ): void {
    this.events.push(
      CustomEvent.parse({
        _tag: "custom",
        at: new Date().toISOString(),
        path,
        stepId,
        type,
        ...(payload === undefined ? {} : { payload }),
      })
    );
  }

  /**
   * Stream of completion values for a step `path`.
   * @internal Lazy Effect-Stream form. Step's `outputChanges` wraps this for JS.
   */
  outputFor<O = unknown>(path: readonly string[]): Stream.Stream<O> {
    return this.events.stream.pipe(
      Stream.filterMap((event) => {
        if (event._tag !== "step.complete") {
          return Option.none();
        }
        if (!Channels.#eventMatchesPath(event, path)) {
          return Option.none();
        }
        return Option.some(event.value as O);
      })
    );
  }

  /**
   * Stream of progress values (0..100) for a step `path`.
   * @internal Lazy Effect-Stream form. Step's `progressChanges` wraps this.
   */
  progressFor(path: readonly string[]): Stream.Stream<number> {
    return this.events.stream.pipe(
      Stream.filterMap((event) => {
        if (event._tag !== "step.progress") {
          return Option.none();
        }
        if (!Channels.#eventMatchesPath(event, path)) {
          return Option.none();
        }
        return Option.some(event.value);
      })
    );
  }

  /**
   * Pre-subscribed status stream (race-free). Synchronously acquires
   * the subscription under Scope to avoid missing early events.
   *
   * @internal Eager form used by Step to mirror events into `#status`.
   */
  subscribeStatus(
    path: readonly string[]
  ): Effect.Effect<Stream.Stream<StepStatus>, never, Scope.Scope> {
    const { pubsub } = this.events;
    return Effect.map(PubSub.subscribe(pubsub), (dequeue) =>
      this.#statusStream(Stream.fromQueue(dequeue), path)
    );
  }

  /**
   * Pre-subscribed completion stream (race-free).
   *
   * @internal Eager form used by Step to mirror events into `#output`.
   */
  subscribeOutput<O = unknown>(
    path: readonly string[]
  ): Effect.Effect<Stream.Stream<O>, never, Scope.Scope> {
    const { pubsub } = this.events;
    return Effect.map(PubSub.subscribe(pubsub), (dequeue) =>
      Stream.fromQueue(dequeue).pipe(
        Stream.filterMap((event) => {
          if (event._tag !== "step.complete") {
            return Option.none();
          }
          if (!Channels.#eventMatchesPath(event, path)) {
            return Option.none();
          }
          return Option.some(event.value as O);
        })
      )
    );
  }

  /**
   * Stream of status values for a step `path` (filters by tag).
   * @internal Lazy Effect-Stream form. See {@link subscribeStatus} for eager variant.
   */
  statusFor(path: readonly string[]): Stream.Stream<StepStatus> {
    return this.#statusStream(this.events.stream, path);
  }

  /**
   * Derive a per-path StepStatus stream by folding events through
   * {@link Snapshot.apply} — the single source of truth for status — and
   * emitting only when this path's projected status actually transitions.
   * Non-status events (progress / resolved / custom) and sibling-path
   * events leave this path's status unchanged, so they naturally produce
   * no emission. Seeded from the live snapshot so a status already in
   * effect at subscription time isn't re-emitted.
   */
  #statusStream(
    source: Stream.Stream<ChannelEvent>,
    path: readonly string[]
  ): Stream.Stream<StepStatus> {
    const key = path.join(".");
    const seed: SnapshotState = Effect.runSync(this.#snapshot.current);
    const seedStatus: StepStatus = seed.steps[key]?.status ?? "pending";
    return source.pipe(
      Stream.mapAccum({ state: seed, status: seedStatus }, (acc, event) => {
        const state = Snapshot.apply(acc.state, event);
        const status: StepStatus = state.steps[key]?.status ?? "pending";
        const out =
          status === acc.status
            ? Option.none<StepStatus>()
            : Option.some(status);
        return [{ state, status }, out];
      }),
      Stream.filterMap((o) => o)
    );
  }

  static #eventMatchesPath(
    event: ChannelEvent,
    path: readonly string[]
  ): boolean {
    if (event._tag === "custom") {
      return false;
    }
    const eventPath = event.path;
    if (eventPath.length !== path.length) {
      return false;
    }
    for (let i = 0; i < path.length; i += 1) {
      if (eventPath[i] !== path[i]) {
        return false;
      }
    }
    return true;
  }

  /**
   * Plain-JS ReadableStream of chunk values for a step.
   * Subscription is established synchronously (race-free).
   * Pass `signal` to close the stream or cancel via the reader.
   */
  chunksFor(
    stepId: string,
    signal?: AbortSignal,
    path?: readonly string[]
  ): ReadableStream<ChunkPayload<S>> {
    const { pubsub } = this.chunks;
    const scope = Effect.runSync(Scope.make());
    const subscription = Effect.runSync(
      PubSub.subscribe(pubsub).pipe(Scope.extend(scope))
    );

    let closed = false;
    let controllerRef: ReadableStreamDefaultController<ChunkPayload<S>> | null =
      null;

    const close = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      Effect.runFork(Scope.close(scope, Exit.void));
      if (controllerRef) {
        try {
          controllerRef.close();
        } catch {
          /* already closed */
        }
      }
    };

    return new ReadableStream<ChunkPayload<S>>({
      cancel() {
        close();
      },
      start(controller) {
        controllerRef = controller;
        if (signal?.aborted) {
          close();
          return;
        }
        signal?.addEventListener("abort", close, { once: true });

        Effect.runFork(
          Effect.gen(function* () {
            while (!closed) {
              const next = yield* subscription.take;
              // `closed` may have flipped while we were blocked on `take`
              // (signal aborted from another callback). Recheck before
              // touching the controller.
              if (closed) {
                return;
              }
              const matches = path
                ? samePath(next.path, path)
                : next.stepId === stepId;
              if (!matches) {
                continue;
              }
              try {
                controller.enqueue(next.payload);
              } catch {
                return;
              }
            }
          })
        );
      },
    });
  }
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((segment, i) => segment === b[i]);
}
