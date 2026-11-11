/**
 * Evidence: an imported image that lettering is reconstructed from. Like a
 * source font it is kept exactly as it arrived and named by the SHA-256 of
 * its file. Nothing in reconstruction writes to its bytes or its pixels.
 */

import { sha256Hex } from "@foundry/lib/digest";
import type { RasterImage } from "~/generation/raster/bitmap";
import type { EncodedFile, ImageCodec } from "~/generation/raster/image-codec";
import {
  pictureTypeFor,
  UNKNOWN_MEDIA_TYPE,
} from "~/generation/raster/media-types";

export interface Evidence {
  /** The file exactly as imported. */
  readonly file: EncodedFile;
  readonly fileName: string;
  readonly height: number;
  /** The SHA-256 digest of the file. */
  readonly id: string;
  /** The decoded picture, four bytes a pixel. Read, never written. */
  readonly pixels: RasterImage;
  readonly width: number;
}

export interface EvidenceFile extends EncodedFile {
  readonly fileName: string;
}

/**
 * Reads an image file as evidence. The decoder belongs to the platform, so
 * it is passed in. Throws the decoder's `UnreadableImageError` for a file
 * that is not a picture.
 */
export const importEvidence = async (
  { bytes, fileName, mediaType }: EvidenceFile,
  codec: Pick<ImageCodec, "decode">
): Promise<Evidence> => {
  const file: EncodedFile = { bytes: bytes.slice(), mediaType };
  const [id, decoded] = await Promise.all([
    sha256Hex(file.bytes),
    codec.decode(file),
  ]);
  return Object.freeze({
    file: Object.freeze(file),
    fileName,
    height: decoded.height,
    id,
    pixels: Object.freeze({
      data: decoded.data.slice(),
      height: decoded.height,
      width: decoded.width,
    }),
    width: decoded.width,
  });
};

const DRAWING = "image/svg+xml";

/**
 * The media type of a photograph, from the ending of its file name. A
 * photograph is pixels: a drawing in SVG is not one, and reads as a file of
 * no known kind, like any other.
 */
export const photographTypeFor = (fileName: string): string => {
  const mediaType = pictureTypeFor(fileName);
  return mediaType === DRAWING ? UNKNOWN_MEDIA_TYPE : mediaType;
};
