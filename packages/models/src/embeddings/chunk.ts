import { modelErrors } from "../errors";

export type ChunkStrategy =
  | { kind: "whole" }
  | { kind: "fixed-cutoff"; maxChars: number };

interface ChunkSpan {
  endLine: number;
  endOffset: number;
  resourceId: string;
  startLine: number;
  startOffset: number;
}

export interface Chunk {
  index: number;
  isChunked: boolean;
  span?: ChunkSpan;
  text: string;
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) === 10) {
      n += 1;
    }
  }
  return n;
}

export function chunk(
  text: string,
  strategy: ChunkStrategy,
  resourceId?: string
): Chunk[] {
  switch (strategy.kind) {
    case "whole":
      return [wholeChunk(text, resourceId)];
    case "fixed-cutoff":
      return fixedCutoff(text, strategy.maxChars, resourceId);
    default:
      throw new Error(
        `[foundry/embeddings] unknown chunk strategy: ${JSON.stringify(strategy satisfies never)}`
      );
  }
}

function wholeChunk(text: string, resourceId?: string): Chunk {
  return {
    index: 0,
    isChunked: false,
    text,
    ...(resourceId === undefined
      ? {}
      : {
          span: {
            endLine: countNewlines(text),
            endOffset: text.length,
            resourceId,
            startLine: 0,
            startOffset: 0,
          },
        }),
  };
}

function fixedCutoff(
  text: string,
  maxChars: number,
  resourceId?: string
): Chunk[] {
  if (maxChars <= 0) {
    throw modelErrors.INVALID_CHUNK_CUTOFF({ maxChars });
  }
  if (text.length <= maxChars) {
    return [wholeChunk(text, resourceId)];
  }
  const chunks: Chunk[] = [];
  let line = 0;
  for (let start = 0, index = 0; start < text.length; start += maxChars) {
    const end = Math.min(start + maxChars, text.length);
    const text_ = text.slice(start, end);
    const startLine = line;
    line += countNewlines(text_);
    chunks.push({
      index,
      isChunked: true,
      text: text_,
      ...(resourceId === undefined
        ? {}
        : {
            span: {
              endLine: line,
              endOffset: end,
              resourceId,
              startLine,
              startOffset: start,
            },
          }),
    });
    index += 1;
  }
  return chunks;
}
