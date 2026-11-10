/** Checking a file before it becomes a source font, and saying what happened to it. */
import type { FaceId, SourceId } from "~/typeface/face";
import {
  type FontReader,
  type OpenFace,
  UnreadableFontError,
} from "~/typeface/reading";

export interface ImportFile {
  /** Kept as the source font, byte for byte. The caller must not write to it afterwards. */
  readonly bytes: Uint8Array;
  /** Set by the app when it made the file itself, for a reconstruction. */
  readonly madeFor?: "reconstruction";
  readonly name: string;
}

/** What happened to one file of an import, in the order the files were given. */
export type ImportReport =
  | {
      readonly status: "imported";
      readonly fileName: string;
      readonly sourceId: SourceId;
      /** One face per member of a font collection, otherwise one. */
      readonly faceIds: readonly FaceId[];
    }
  | {
      readonly status: "duplicate";
      readonly fileName: string;
      /** The source font that already holds these bytes. */
      readonly sourceId: SourceId;
    }
  | {
      readonly status: "rejected";
      readonly fileName: string;
      readonly reason: string;
    };

/** Opens every face in the file. Opens nothing when any face cannot be read. */
export const openEveryFace = (
  reader: FontReader,
  bytes: Uint8Array
): OpenFace[] => {
  const faces: OpenFace[] = [];
  try {
    const count = reader.faceCount(bytes);
    for (let index = 0; index < count; index += 1) {
      faces.push(reader.open(bytes, index));
    }
  } catch (error) {
    closeFaces(faces);
    throw error;
  }
  return faces;
};

export const closeFaces = (faces: readonly OpenFace[]) => {
  for (const face of faces) {
    face.close();
  }
};

/** Why a file was turned away, in plain words. */
export const rejectionReason = (bytes: Uint8Array, error: unknown) => {
  if (bytes.byteLength === 0) {
    return "This file is empty.";
  }
  return error instanceof UnreadableFontError
    ? error.message
    : "This file could not be read as a font.";
};

export const rejectionMessage = (fileName: string, reason: string) =>
  `Could not import ${fileName}. ${reason} Check the file and import it again, or choose another font.`;

export const duplicateMessage = (fileName: string, existingName: string) =>
  fileName === existingName
    ? `${fileName} is already imported.`
    : `${fileName} is already imported. It is the same file as ${existingName}.`;
