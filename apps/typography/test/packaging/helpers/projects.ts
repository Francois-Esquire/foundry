import type { CharacterLookups } from "~/packaging/export-plan";
import { sourceGlyph } from "~/typeface/changes";
import type { FaceDescription, FaceId } from "~/typeface/face";
import {
  addSource,
  commit,
  emptyProject,
  type TypefaceProject,
} from "~/typeface/project";
import { stamp } from "../../helpers/fixed";

export interface Imported {
  readonly faceId: FaceId;
  readonly project: TypefaceProject;
}

/** Adds one single-face source to a project. The digest only has to be distinct. */
export const importFace = (
  project: TypefaceProject,
  fileName: string,
  description: FaceDescription,
  bytes: Uint8Array = new TextEncoder().encode(fileName)
): Imported => {
  const id = `${fileName}-digest`.padEnd(64, "0");
  const next = addSource(
    project,
    { bytes, fileName, id, importedAt: "2026-11-10T09:00:00.000Z" },
    [description]
  );
  const face = next.faces.find((candidate) => candidate.sourceId === id);
  if (!face) {
    throw new Error(`${fileName} was not added.`);
  }
  return { faceId: face.id, project: next };
};

export const startProject = (
  fileName: string,
  description: FaceDescription,
  bytes?: Uint8Array
) => importFace(emptyProject(), fileName, description, bytes);

/** Gives glyph 1 a new advance, which is enough to make the face modified. */
export const withAnEdit = (project: TypefaceProject, faceId: FaceId) =>
  commit(project, {
    ...stamp(),
    changes: [
      { advance: 640, faceId, glyph: sourceGlyph(1), kind: "advance-changed" },
    ],
    label: "Widen a glyph",
  });

export const span = (first: number, last: number) =>
  Array.from({ length: last - first + 1 }, (_, index) => first + index);

/** Small stand-ins for the Unicode data, and the characters each face maps. */
export const fakeLookups = (
  faces: Readonly<Record<FaceId, readonly number[]>>
): CharacterLookups => ({
  charactersOfBlock: (block) =>
    block === "Basic Latin" ? span(0x00, 0x7f) : [],
  charactersOfFace: (faceId) => faces[faceId] ?? [],
  charactersOfLanguage: (language) =>
    language === "hi" ? [0x09_15, 0x09_4d, 0x09_37] : [],
  charactersOfScript: (script) => {
    if (script === "Deva") {
      return span(0x09_00, 0x09_7f);
    }
    return script === "Grek" ? span(0x03_91, 0x03_a9) : [];
  },
});
