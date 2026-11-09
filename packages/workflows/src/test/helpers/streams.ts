import type { Stream as StreamType } from "effect";

import { Effect, Stream } from "effect";

import type { ChannelChunk, ChannelEvent, ChunkPayload } from "../../channels";
import type { Step } from "../../step";

/**
 * Anything that exposes a `.channels.events.stream` (Step, Workflow's
 * inner step) plus the channels themselves and a raw Stream all reduce
 * to "give me a Stream<ChannelEvent>". This type captures the union
 * `collectEvents` can normalize. Same shape exists for chunks below.
 */
type EventSource =
  | StreamType.Stream<ChannelEvent>
  | {
      readonly channels: {
        readonly events: { readonly stream: StreamType.Stream<ChannelEvent> };
      };
    }
  | { readonly events: { readonly stream: StreamType.Stream<ChannelEvent> } };

type ChunkSource =
  | StreamType.Stream<ChannelChunk>
  | {
      readonly channels: {
        readonly chunks: { readonly stream: StreamType.Stream<ChannelChunk> };
      };
    }
  | { readonly chunks: { readonly stream: StreamType.Stream<ChannelChunk> } };

function eventStreamOf(source: EventSource): StreamType.Stream<ChannelEvent> {
  if ("channels" in source) {
    return source.channels.events.stream;
  }
  if ("events" in source) {
    return source.events.stream;
  }
  return source;
}

function chunkStreamOf(source: ChunkSource): StreamType.Stream<ChannelChunk> {
  if ("channels" in source) {
    return source.channels.chunks.stream;
  }
  if ("chunks" in source) {
    return source.chunks.stream;
  }
  return source;
}

export interface CollectHandle<T> {
  /** Live array reference — read after your assertion gates. */
  readonly events: T[];
  /** Interrupt the underlying fiber. Idempotent. */
  stop(): void;
}

export interface CollectChunkHandle {
  readonly chunks: ChannelChunk[];
  stop(): void;
}

export interface CollectOptions {
  /**
   * If supplied, the helper stops on its own once `take` envelopes have
   * been collected (the fiber drains until the underlying `Stream.take`
   * completes). Useful when the test knows the exact arrival count.
   */
  readonly take?: number;
}

/**
 * Subscribe synchronously to a channel-event stream and collect into a
 * live array. The subscription is established before this function
 * returns, so writes that follow are not raced.
 */
export function collectEvents(
  source: EventSource,
  options: CollectOptions = {}
): CollectHandle<ChannelEvent> {
  const events: ChannelEvent[] = [];
  const base = eventStreamOf(source);
  const stream =
    options.take === undefined ? base : base.pipe(Stream.take(options.take));
  const fiber = Effect.runFork(
    Stream.runForEach(stream, (e) =>
      Effect.sync(() => {
        events.push(e);
      })
    )
  );
  return {
    events,
    stop: () => {
      Effect.runFork(fiber.interruptAsFork(fiber.id()));
    },
  };
}

/**
 * Subscribe synchronously to a channel-chunk stream and collect into a
 * live array. Same shape as `collectEvents`.
 */
export function collectChunks(
  source: ChunkSource,
  options: CollectOptions = {}
): CollectChunkHandle {
  const chunks: ChannelChunk[] = [];
  const base = chunkStreamOf(source);
  const stream =
    options.take === undefined ? base : base.pipe(Stream.take(options.take));
  const fiber = Effect.runFork(
    Stream.runForEach(stream, (c) =>
      Effect.sync(() => {
        chunks.push(c);
      })
    )
  );
  return {
    chunks,
    stop: () => {
      Effect.runFork(fiber.interruptAsFork(fiber.id()));
    },
  };
}

/**
 * Pre-subscribe to a step's public `ReadableStream<ChunkPayload>` and
 * collect up to `count` payloads. The reader is acquired before this returns.
 */
export async function takePayloads(
  step: Step,
  count: number
): Promise<ChunkPayload[]> {
  const reader = step.stream.getReader();
  const payloads: ChunkPayload[] = [];
  for (let i = 0; i < count; i += 1) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    payloads.push(value);
  }
  reader.releaseLock();
  return payloads;
}
