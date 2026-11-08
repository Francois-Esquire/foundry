import { decodeDocument, encodeDocument } from "./codec.ts";
import {
  type AnnotationDocument,
  LIMITS,
  MARK_KINDS,
  type ShareResult,
} from "./model.ts";

export const NOTES_PARAM = "notes";
/** Practical complete-URL budget for QR codes; a product target, not a guarantee. */
export const QR_TARGET_BYTES = 2000;
/** Complete-URL hard limit; larger documents stay local instead of being truncated. */
export const MAX_URL_BYTES = 8000;
const MAX_EXPANDED_BYTES = 1_000_000;
const BASE64_URL = /^[\da-z_-]*$/i;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function compact(document: AnnotationDocument): string {
  return JSON.stringify(
    document.marks.map((mark) => [
      mark.id,
      MARK_KINDS.indexOf(mark.kind),
      mark.color.slice(1),
      mark.anchor.id,
      mark.anchor.x,
      mark.anchor.y,
      mark.points.flatMap((point) => [point.x, point.y]),
      mark.text,
      mark.target?.segments.map((segment) => [
        segment.blockId,
        segment.start,
        segment.end,
        segment.quote,
        segment.prefix,
        segment.suffix,
      ]) ?? null,
    ])
  );
}

function expandTarget(value: unknown): unknown {
  if (value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > LIMITS.segmentsPerTarget) {
    throw new Error("Invalid annotation text target.");
  }
  const segments: unknown[] = [];
  for (const segment of value) {
    if (!Array.isArray(segment) || segment.length !== 6) {
      throw new Error("Invalid annotation text segment.");
    }
    segments.push({
      blockId: segment[0],
      end: segment[2],
      prefix: segment[4],
      quote: segment[3],
      start: segment[1],
      suffix: segment[5],
    });
  }
  return { segments };
}

function expandMark(row: unknown): unknown {
  if (
    !Array.isArray(row) ||
    row.length !== 9 ||
    !Array.isArray(row[6]) ||
    row[6].length % 2 !== 0 ||
    row[6].length > LIMITS.pointsPerStroke * 2 ||
    !Number.isInteger(row[1]) ||
    row[1] < 0 ||
    row[1] >= MARK_KINDS.length ||
    typeof row[2] !== "string"
  ) {
    throw new Error("Invalid annotation mark.");
  }
  const points: unknown[] = [];
  for (let index = 0; index < row[6].length; index += 2) {
    points.push({ x: row[6][index], y: row[6][index + 1] });
  }
  const target = expandTarget(row[8]);
  return {
    anchor: { id: row[3], x: row[4], y: row[5] },
    color: `#${row[2]}`,
    id: row[0],
    kind: MARK_KINDS[row[1]],
    points,
    text: row[7],
    ...(target === undefined ? {} : { target }),
  };
}

/** Reconstruct unknown input, then apply the same validator as local storage. */
function expand(source: string): AnnotationDocument | null {
  const rows: unknown = JSON.parse(source);
  if (!Array.isArray(rows) || rows.length > LIMITS.marks) {
    return null;
  }
  return decodeDocument(
    JSON.stringify({ marks: rows.map(expandMark), version: 1 })
  );
}

function toBase64(bytes: Uint8Array): string {
  let source = "";
  for (const byte of bytes) {
    source += String.fromCharCode(byte);
  }
  return btoa(source)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function fromBase64(source: string): Uint8Array<ArrayBuffer> {
  if (!BASE64_URL.test(source) || source.length % 4 === 1) {
    throw new Error("Invalid annotation payload.");
  }
  const decoded = atob(source.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

async function transform(
  bytes: Uint8Array<ArrayBuffer>,
  decompress: boolean
): Promise<Uint8Array<ArrayBuffer>> {
  const codec = decompress
    ? new DecompressionStream("gzip")
    : new CompressionStream("gzip");
  const reader = new Blob([bytes]).stream().pipeThrough(codec).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    let next = await reader.read();
    while (!next.done) {
      length += next.value.byteLength;
      if (length > MAX_EXPANDED_BYTES) {
        await reader.cancel();
        throw new Error("Annotation payload exceeds the expanded size limit.");
      }
      chunks.push(next.value);
      next = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function shareReadyMessage(bytes: number): string {
  return bytes <= QR_TARGET_BYTES
    ? `Share link ready (${bytes.toLocaleString()} bytes, within the ${QR_TARGET_BYTES.toLocaleString()}-byte QR target).`
    : `Share link ready (${bytes.toLocaleString()} bytes). It exceeds the ${QR_TARGET_BYTES.toLocaleString()}-byte QR target.`;
}

/** A self-contained link; size limits never truncate or discard marks. */
export async function encodeShare(
  document: AnnotationDocument,
  baseUrl: string
): Promise<ShareResult> {
  try {
    encodeDocument(document);
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("Annotation links require an HTTP URL.");
    }
    url.searchParams.delete(NOTES_PARAM);
    const bytes = encoder.encode(compact(document));
    if (bytes.byteLength > MAX_EXPANDED_BYTES) {
      return {
        bytes: bytes.byteLength,
        message:
          "These annotations are too large for a self-contained link. They remain saved locally.",
        qrReady: false,
      };
    }
    const raw = `1r.${toBase64(bytes)}`;
    let payload = raw;
    if (typeof CompressionStream !== "undefined") {
      try {
        const compressed = `1g.${toBase64(await transform(bytes, false))}`;
        if (compressed.length < raw.length) {
          payload = compressed;
        }
      } catch {
        // A browser may expose the constructor without supporting gzip.
        payload = raw;
      }
    }
    url.searchParams.set(NOTES_PARAM, payload);
    const result = url.href;
    const length = encoder.encode(result).byteLength;
    if (length > MAX_URL_BYTES) {
      return {
        bytes: length,
        message: `This link would be ${length.toLocaleString()} bytes, above the ${MAX_URL_BYTES.toLocaleString()}-byte limit. Your annotations remain saved locally.`,
        qrReady: false,
      };
    }
    return {
      bytes: length,
      message: shareReadyMessage(length),
      qrReady: length <= QR_TARGET_BYTES,
      url: result,
    };
  } catch {
    return {
      bytes: 0,
      message:
        "These annotations could not be encoded. Your current notes have not been changed.",
      qrReady: false,
    };
  }
}

export interface SharedDocument {
  document?: AnnotationDocument;
  message: string;
  status: "absent" | "invalid" | "valid";
}

/** Decode with bounded input and bounded streaming decompression. */
export async function decodeShare(sourceUrl: string): Promise<SharedDocument> {
  try {
    if (sourceUrl.length > MAX_URL_BYTES) {
      throw new Error("Annotation link exceeds the input size limit.");
    }
    const url = new URL(sourceUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("Annotation links require an HTTP URL.");
    }
    const values = url.searchParams.getAll(NOTES_PARAM);
    if (values.length === 0) {
      return {
        message: "No shared annotations in this link.",
        status: "absent",
      };
    }
    if (
      values.length !== 1 ||
      encoder.encode(url.href).byteLength > MAX_URL_BYTES
    ) {
      throw new Error("Invalid or oversized annotation link.");
    }
    const payload = values[0] ?? "";
    if (!(payload.startsWith("1g.") || payload.startsWith("1r."))) {
      throw new Error("Unsupported annotation link version.");
    }
    let bytes = fromBase64(payload.slice(3));
    if (payload.startsWith("1g.")) {
      bytes = await transform(bytes, true);
    }
    if (bytes.byteLength > MAX_EXPANDED_BYTES) {
      throw new Error("Annotation payload is too large.");
    }
    const document = expand(decoder.decode(bytes));
    if (!document) {
      throw new Error("Invalid annotation document.");
    }
    return {
      document,
      message: "Shared annotations loaded from this link.",
      status: "valid",
    };
  } catch {
    return {
      message:
        "The shared annotations could not be read. Your saved notes have not been changed.",
      status: "invalid",
    };
  }
}
