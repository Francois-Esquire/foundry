/**
 * Evidence: an imported image that lettering is reconstructed from. Like a
 * source font it is kept exactly as it arrived and named by the SHA-256 of
 * its file. Nothing in reconstruction writes to its bytes or its pixels.
 */
import type { RasterImage } from "~/generation/raster/bitmap";
import type { EncodedFile, ImageCodec } from "~/generation/raster/image-codec";
import { digestOf } from "~/typeface/project";

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
    digestOf(file.bytes),
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

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** The media type a file name's ending suggests, for files that arrive without one. */
export const mediaTypeFor = (fileName: string): string =>
  MEDIA_TYPES[fileName.split(".").at(-1)?.toLowerCase() ?? ""] ??
  "application/octet-stream";
