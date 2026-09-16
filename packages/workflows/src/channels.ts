import { Effect, Exit, Option, PubSub, Schema, Scope, Stream } from "effect";

import type { JsonValue } from "./execution-records";
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

// ── Event schemas ──

/** Suspension metadata payload (carried on `step.suspended`). */
export const SuspensionStateSchema = Schema.Struct({
  kind: Schema.optional(Schema.String),
  meta: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown })
  ),
  name: Schema.String,
  occurrence: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.nonNegative())
  ),
  reason: Schema.String,
  request: Schema.optional(Schema.Unknown),
  stepPath: Schema.optional(Schema.Array(Schema.String)),
  suspendedAt: Schema.String,
});
export type SuspensionState = Schema.Schema.Type<typeof SuspensionStateSchema>;

/** Input accepted by Step suspension while legacy `meta` remains supported. */
export interface SuspensionRequest {
  readonly kind?: string;
  readonly meta?: Record<string, unknown>;
  readonly name: string;
  readonly reason: string;
  readonly request?: JsonValue;
}

/** Captured error shape (carried on `step.failed`). */
export const ErrorShapeSchema = Schema.Struct({
  message: Schema.String,
  name: Schema.String,
  stack: Schema.optional(Schema.String),
});
type ErrorShape = Schema.Schema.Type<typeof ErrorShapeSchema>;

const lifecycleCommon = {
  at: Schema.String,
  attempt: Schema.Number,
  name: Schema.String,
  path: Schema.Array(Schema.String),
};

export const StepStartedEvent = Schema.TaggedStruct(
  "step.started",
  lifecycleCommon
);
export const StepCompleteEvent = Schema.TaggedStruct("step.complete", {
  ...lifecycleCommon,
  value: Schema.Unknown,
});
export const StepFailedEvent = Schema.TaggedStruct("step.failed", {
  ...lifecycleCommon,
  error: ErrorShapeSchema,
});
export const StepBailedEvent = Schema.TaggedStruct("step.bailed", {
  ...lifecycleCommon,
  bail: Schema.Unknown,
});
export const StepSuspendedEvent = Schema.TaggedStruct("step.suspended", {
  ...lifecycleCommon,
  suspension: SuspensionStateSchema,
});

export const StepPausedEvent = Schema.TaggedStruct("step.paused", {
  ...lifecycleCommon,
  reason: Schema.optional(Schema.String),
});

export const StepResumedEvent = Schema.TaggedStruct(
  "step.resumed",
  lifecycleCommon
);

export const StepSkippedEvent = Schema.TaggedStruct("step.skipped", {
  ...lifecycleCommon,
  reason: Schema.optional(Schema.String),
});

export const StepAbortedEvent = Schema.TaggedStruct("step.aborted", {
  ...lifecycleCommon,
  reason: Schema.optional(Schema.Unknown),
});

export const StepProgressEvent = Schema.TaggedStruct("step.progress", {
  ...lifecycleCommon,
  value: Schema.Number,
});

export const StepResolvedEvent = Schema.TaggedStruct("step.resolved", {
  ...lifecycleCommon,
  suspensionName: Schema.String,
  value: Schema.Unknown,
});

export const CustomEvent = Schema.TaggedStruct("custom", {
  at: Schema.String,
  path: Schema.Array(Schema.String),
  payload: Schema.optional(Schema.Unknown),
  stepId: Schema.String,
  type: Schema.String,
});

export const ChannelEventSchema = Schema.Union(
  StepStartedEvent,
  StepCompleteEvent,
  StepFailedEvent,
  StepBailedEvent,
  StepSuspendedEvent,
  StepPausedEvent,
  StepResumedEvent,
  StepSkippedEvent,
  StepAbortedEvent,
  StepResolvedEvent,
  StepProgressEvent,
  CustomEvent
);
export type ChannelEvent = Schema.Schema.Type<typeof ChannelEventSchema>;

// ── Other message types ──

/** Chunk payload: text or data. */
export type ChunkPayload<S = unknown> =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "data"; readonly data: S };

/** A chunk from a step's output stream. */
export interface ChannelChunk<S = unknown> {
  readonly at: string;
  readonly payload: ChunkPayload<S>;
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
  }) {
    this.events = args.events;
    this.chunks = args.chunks;
    this.stream = args.stream;
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
  static make<S = unknown>(
    snapshot: Snapshot
  ): Effect.Effect<Channels<S>, never, Scope.Scope> {
    return Effect.gen(function* () {
      // Allocate raw PubSubs.
      const eventsPubSub = yield* Effect.acquireRelease(
        PubSub.unbounded<ChannelEvent>(),
        (h) => PubSub.shutdown(h)
      );
      const chunksPubSub = yield* Effect.acquireRelease(
        PubSub.unbounded<ChannelChunk<S>>(),
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

      // chunks: pure broadcast (no Snapshot side-effect).
      const chunks: PubSubChannel<ChannelChunk<S>> = {
        publish: (chunk) => PubSub.publish(chunksPubSub, chunk),
        pubsub: chunksPubSub,
        push: (chunk) => Effect.runSync(PubSub.publish(chunksPubSub, chunk)),
        stream: Stream.fromPubSub(chunksPubSub),
      };

      // Native multiplexer — buffers until the ReadableStream's
      // controller exists, then enqueues directly. Scope finalizer
      // closes the controller so consumers see EOF on scope close.
      let controller: ReadableStreamDefaultController<
        ChannelMessage<S>
      > | null = null;
      let closed = false;
      const buffer: ChannelMessage<S>[] = [];

      const enqueue = (msg: ChannelMessage<S>): void => {
        if (closed) {
          return;
        }
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
          if (controller) {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        })
      );

      const stream = new ReadableStream<ChannelMessage<S>>({
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

      return new Channels<S>({ chunks, events, snapshot, stream });
    });
  }

  /** Returns this (shared per Run). */
  fork(): this {
    return this;
  }

  // ── Event emitters ──
  // Single construction site per lifecycle event. Callers pass only the
  // variable fields; the helper fills `at` at push time. Replaces the
  // hand-built object literals previously spread across step / executable /
  // composer (one place spells the `{ path, name, attempt, at }` shape).

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
    this.events.push(StepStartedEvent.make(this.#base(path, name, attempt)));
  }

  /** Push `step.complete`. */
  complete(
    path: readonly string[],
    name: string,
    attempt: number,
    value: unknown
  ): void {
    this.events.push(
      StepCompleteEvent.make({ ...this.#base(path, name, attempt), value })
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
      StepFailedEvent.make({ ...this.#base(path, name, attempt), error })
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
      StepBailedEvent.make({ ...this.#base(path, name, attempt), bail })
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
      StepSuspendedEvent.make({
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
      StepPausedEvent.make({
        ...this.#base(path, name, attempt),
        ...(reason === undefined ? {} : { reason }),
      })
    );
  }

  /** Push `step.resumed`. */
  resumed(path: readonly string[], name: string, attempt: number): void {
    this.events.push(StepResumedEvent.make(this.#base(path, name, attempt)));
  }

  /** Push `step.skipped`. */
  skipped(
    path: readonly string[],
    name: string,
    attempt: number,
    reason?: string
  ): void {
    this.events.push(
      StepSkippedEvent.make({
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
      StepAbortedEvent.make({
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
      StepProgressEvent.make({ ...this.#base(path, name, attempt), value })
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
      CustomEvent.make({
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
    const pubsub = this.events.pubsub;
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
    const pubsub = this.events.pubsub;
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
    for (let i = 0; i < path.length; i++) {
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
    signal?: AbortSignal
  ): ReadableStream<ChunkPayload<S>> {
    const pubsub = this.chunks.pubsub;
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
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
              if (closed) {
                return;
              }
              if (next.stepId !== stepId) {
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
