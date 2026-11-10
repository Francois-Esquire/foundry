/**
 * The port for image files. Decoding and encoding belong to the platform: a
 * canvas in the browser, a library in Node. Nothing else here touches either.
 */
import type { RasterImage } from "./bitmap";

/** An image or SVG file exactly as it was received or will be sent. */
export interface EncodedFile {
  readonly bytes: Uint8Array;
  /** For example image/png or image/svg+xml. */
  readonly mediaType: string;
}

export interface ImageCodec {
  /** Reads a PNG, JPEG or other picture file into pixels. */
  decode(file: EncodedFile): Promise<RasterImage>;
  encodePng(image: RasterImage): Promise<Uint8Array>;
}

export class UnreadableImageError extends Error {
  override readonly name = "UnreadableImageError";
}

const CHUNK = 0x80_00;

/** A file as a data URI, the form a model API accepts in place of a URL. */
export const toDataUri = ({ bytes, mediaType }: EncodedFile): string => {
  let binary = "";
  for (let start = 0; start < bytes.length; start += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(start, start + CHUNK));
  }
  return `data:${mediaType};base64,${btoa(binary)}`;
};

const DATA_URI = /^data:([^;,]*)(;base64)?,(.*)$/s;

/** The file inside a data URI, or nothing when the text is not one. */
export const fromDataUri = (uri: string): EncodedFile | undefined => {
  const [, mediaType, base64, body] = DATA_URI.exec(uri) ?? [];
  if (body === undefined) {
    return;
  }
  const binary = base64 ? atob(body) : decodeURIComponent(body);
  return {
    bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    mediaType: mediaType || "application/octet-stream",
  };
};
