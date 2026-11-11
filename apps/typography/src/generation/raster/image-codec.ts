/**
 * The port for image files. Decoding and encoding belong to the platform: a
 * canvas in the browser, a library in Node. Nothing else here touches either.
 */

import { base64ToBytes, bytesToBase64 } from "@foundry/lib/encoding";
import type { RasterImage } from "./bitmap";
import { UNKNOWN_MEDIA_TYPE } from "./media-types";

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

/** A file as a data URI, the form a model API accepts in place of a URL. */
export const toDataUri = ({ bytes, mediaType }: EncodedFile): string =>
  `data:${mediaType};base64,${bytesToBase64(bytes)}`;

const DATA_URI = /^data:([^;,]*)(;base64)?,(.*)$/s;

/** The file inside a data URI, or nothing when the text is not one. */
export const fromDataUri = (uri: string): EncodedFile | undefined => {
  const [, mediaType, base64, body] = DATA_URI.exec(uri) ?? [];
  if (body === undefined) {
    return;
  }
  return {
    bytes: base64
      ? base64ToBytes(body)
      : Uint8Array.from(decodeURIComponent(body), (character) =>
          character.charCodeAt(0)
        ),
    mediaType: mediaType || UNKNOWN_MEDIA_TYPE,
  };
};
