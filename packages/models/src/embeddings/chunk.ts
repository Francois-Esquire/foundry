import { modelErrors } from "../errors";

export type ChunkStrategy =
  | { kind: "whole" }
  | { kind: "fixed-cutoff"; maxChars: number };

/**
 * Source provenance for a chunk — where in the original resource this chunk
 * came from, so chunks can be stitched back together or revised in place.
 *
 * Offsets are zero-based UTF-16 code units (JS string indices) and exact:
 * `resource.slice(startOffset, endOffset) === text`. **Revise via offsets** —
 * they round-trip losslessly; the line numbers are for human display.
 *
 * Lines are zero-based. `startLine` is the line of the chunk's first character
 * (`countNewlines(resource.slice(0, startOffset))`). `endLine` is a *position*
 * pointer, not an inclusive bound: it is the line at `endOffset`, i.e. the line
 * the next chunk begins on (`countNewlines(resource.slice(0, endOffset))`), and
 * equals the successor chunk's `startLine` — that is what makes spans stitch.
 *
 * Because a cut can land mid-line, `[startLine, endLine]` is NOT the set of
 * lines the chunk occupies: when the chunk ends mid-line both bounds and the
 * next chunk name the same shared line. For the inclusive last line a chunk
 * touches, use `countNewlines(resource.slice(0, endOffset - 1))`.
 */
export interface ChunkSpan {
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

/**
 * Counts `\n` occurrences in `s`. Used to advance line numbers across chunks
 * without re-slicing the resource from offset 0 each time.
 */
export function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) === 10) {
      n += 1;
    }
  }
  return n;
}

/**
 * Chunks `text` per `strategy`. When `resourceId` is provided, each chunk
 * carries a {@link ChunkSpan} locating it in the source so chunks can be
 * stitched back together or revised in place. Omit `resourceId` to skip
 * provenance entirely (no `span` field is set).
 */
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
