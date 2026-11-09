import {
  type AnnotationDocument,
  LIMITS,
  MARK_KINDS,
  type Mark,
  type Point,
  TEXT_MARK_KINDS,
  type TextTarget,
} from "./model.ts";

const MAX_DOCUMENT_LENGTH = 8_000_000;
const MAX_COORDINATE = 100_000;
const HEX_COLOR = /^#[\da-f]{6}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCoordinate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_COORDINATE
  );
}

function isPoint(value: unknown): value is Point {
  return isRecord(value) && isCoordinate(value.x) && isCoordinate(value.y);
}

function isTarget(value: unknown): value is TextTarget {
  if (
    !(isRecord(value) && Array.isArray(value.segments)) ||
    value.segments.length === 0 ||
    value.segments.length > LIMITS.segmentsPerTarget
  ) {
    return false;
  }
  let quoteLength = 0;
  for (const segment of value.segments) {
    if (
      !(
        isRecord(segment) &&
        typeof segment.blockId === "string" &&
        segment.blockId.length > 0 &&
        segment.blockId.length <= 512 &&
        typeof segment.start === "number" &&
        Number.isSafeInteger(segment.start) &&
        segment.start >= 0 &&
        segment.start <= 1_000_000 &&
        typeof segment.end === "number" &&
        Number.isSafeInteger(segment.end) &&
        segment.end > segment.start &&
        segment.end <= 1_000_000 &&
        typeof segment.quote === "string" &&
        segment.quote.length === segment.end - segment.start &&
        typeof segment.prefix === "string" &&
        segment.prefix.length <= 64 &&
        typeof segment.suffix === "string" &&
        segment.suffix.length <= 64
      )
    ) {
      return false;
    }
    quoteLength += segment.quote.length;
  }
  return quoteLength <= LIMITS.quoteLength;
}

function includes(list: readonly string[], value: unknown): boolean {
  return typeof value === "string" && list.includes(value);
}

function isMark(value: unknown): value is Mark {
  if (!(isRecord(value) && isRecord(value.anchor))) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 128 &&
    typeof value.anchor.id === "string" &&
    value.anchor.id.length > 0 &&
    value.anchor.id.length <= 512 &&
    isPoint(value.anchor) &&
    includes(MARK_KINDS, value.kind) &&
    (value.target === undefined || isTarget(value.target)) &&
    (!includes(TEXT_MARK_KINDS, value.kind) || isTarget(value.target)) &&
    Array.isArray(value.points) &&
    value.points.length <= LIMITS.pointsPerStroke &&
    value.points.every(isPoint) &&
    typeof value.text === "string" &&
    value.text.length <= LIMITS.noteLength &&
    typeof value.color === "string" &&
    HEX_COLOR.test(value.color)
  );
}

function isAnnotationDocument(value: unknown): value is AnnotationDocument {
  return (
    isRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.marks) &&
    value.marks.length <= LIMITS.marks &&
    value.marks.every(isMark) &&
    new Set(value.marks.map((mark) => mark.id)).size === value.marks.length
  );
}

/** Return null for unsupported or malformed data; never partially import it. */
export function decodeDocument(source: string): AnnotationDocument | null {
  if (source.length > MAX_DOCUMENT_LENGTH) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(source);
    return isAnnotationDocument(value) ? value : null;
  } catch {
    return null;
  }
}

export function encodeDocument(document: AnnotationDocument): string {
  if (!isAnnotationDocument(document)) {
    throw new Error("The annotations exceed the supported document limits.");
  }
  const source = JSON.stringify(document);
  if (source.length > MAX_DOCUMENT_LENGTH) {
    throw new Error("The annotations exceed the supported document size.");
  }
  return source;
}
