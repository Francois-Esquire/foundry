import type { Chunk } from "@chonkiejs/core";

export type ChunkSource = string | Iterable<string> | AsyncIterable<string>;

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

export async function* streamFrom(
  input: ChunkSource,
  chunkFn: (text: string) => Promise<Chunk[]>
): AsyncGenerator<Chunk> {
  const text = await collectSource(input);
  for (const chunk of await chunkFn(text)) {
    yield chunk;
  }
}
