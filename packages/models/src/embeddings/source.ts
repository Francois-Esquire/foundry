import type { Chunk } from "@chonkiejs/core";

/**
 * A text source for chunking: a whole string, or a sync/async stream of pieces
 * (a file read, a network body, an LLM token stream). `for await` consumes both
 * `Iterable` and `AsyncIterable`, so one accumulator handles every form.
 */
export type ChunkSource = string | Iterable<string> | AsyncIterable<string>;

/** Accumulate any {@link ChunkSource} into a single string. */
export async function collectSource(input: ChunkSource): Promise<string> {
  if (typeof input === "string") {
    return input;
  }
  let text = "";
  for await (const piece of input) {
    text += piece;
  }
  return text;
}

/**
 * Stream chunks from a source.
 *
 * **Not incremental.** The chonkie chunkers (recursive, semantic) operate on the
 * whole document — recursion needs the full string, and semantic boundary
 * detection needs the global similarity signal across every sentence. So this
 * *buffers the entire source first*, chunks it, then yields the chunks one by
 * one. The value is ergonomic and compositional (a chunk stream is a source the
 * embedder can consume), **not** constant-memory streaming of an unbounded
 * input. Don't feed it a 1GB stream expecting bounded memory.
 */
export async function* streamFrom(
  input: ChunkSource,
  chunkFn: (text: string) => Promise<Chunk[]>
): AsyncGenerator<Chunk> {
  const text = await collectSource(input);
  for (const chunk of await chunkFn(text)) {
    yield chunk;
  }
}
