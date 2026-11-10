import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import type { FontReader, OpenFace } from "~/typeface/reading";
import type { ImportFile } from "~/workspace/importing";
import { createWorkspace, type Workspace } from "~/workspace/workspace";
import { FONTS, fontBytes } from "./fixtures";

export const FIXED_TIME = "2026-11-10T09:00:00.000Z";

/** A workspace over the real reader, with a fixed clock and ids that count up from id-1. */
export const testWorkspace = (reader: FontReader = harfBuzzReader) => {
  let issued = 0;
  return createWorkspace({
    newId: () => {
      issued += 1;
      return `id-${issued}`;
    },
    now: () => FIXED_TIME,
    reader,
  });
};

export const fixtureFile = (name: keyof typeof FONTS): ImportFile => ({
  bytes: fontBytes(name),
  name: FONTS[name],
});

/** Imports one file and returns its source id and face ids. Throws when the import is refused. */
export const importOne = async (workspace: Workspace, file: ImportFile) => {
  const [report] = await workspace.importFonts([file]);
  if (report?.status !== "imported") {
    throw new Error(`${file.name} was not imported: ${report?.status}`);
  }
  const [faceId] = report.faceIds;
  if (faceId === undefined) {
    throw new Error(`${file.name} has no face`);
  }
  return { faceId, faceIds: report.faceIds, sourceId: report.sourceId };
};

/** The real reader, counting the faces it has opened and the ones closed since. */
export const countingReader = () => {
  const counts = { closed: 0, opened: 0 };
  const counted = (face: OpenFace): OpenFace => ({
    characters: () => face.characters(),
    charactersForGlyph: (glyphId) => face.charactersForGlyph(glyphId),
    close: () => {
      counts.closed += 1;
      face.close();
    },
    description: face.description,
    glyph: (glyphId, location) => face.glyph(glyphId, location),
    glyphForCharacter: (codePoint) => face.glyphForCharacter(codePoint),
    glyphName: (glyphId) => face.glyphName(glyphId),
    shape: (text, options) => face.shape(text, options),
  });
  const reader: FontReader = {
    faceCount: (bytes) => harfBuzzReader.faceCount(bytes),
    open: (bytes, index) => {
      counts.opened += 1;
      return counted(harfBuzzReader.open(bytes, index));
    },
  };
  return { counts, reader };
};
