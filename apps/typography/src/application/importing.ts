/** The import command: source fonts and photographs, each kept as an artifact. */
import { UnreadableImageError } from "~/generation/raster/image-codec";
import { readEvidence } from "~/reconstruct/core";
import { photographTypeFor } from "~/reconstruction/evidence/evidence";
import { faceListLabel } from "~/typeface/face";
import type {
  GivenFile,
  Imported,
  ImportedFont,
  ImportedPhotograph,
} from "./application";
import type { OpenProject } from "./open-project";

type Refused = Imported["refused"][number];

const importFont = async (
  open: OpenProject,
  file: GivenFile
): Promise<ImportedFont | Refused> => {
  const [report] = await open.workspace.importFonts([file]);
  if (!report || report.status === "rejected") {
    return {
      name: file.name,
      reason: report?.reason ?? "This file could not be read as a font.",
    };
  }
  const artifactOf = await open.keepSources();
  return {
    alreadyImported: report.status === "duplicate",
    artifactId: artifactOf(report.sourceId),
    faces: open.workspace
      .getState()
      .project.faces.filter((face) => face.sourceId === report.sourceId)
      .map((face) => ({ faceId: face.id, label: faceListLabel(face) })),
    fileName: file.name,
  };
};

const importPhotograph = async (
  open: OpenProject,
  file: GivenFile
): Promise<ImportedPhotograph | Refused> => {
  let digest: string;
  try {
    // Read as evidence first, so a file that is not a picture is never kept.
    ({ id: digest } = await readEvidence(
      { bytes: file.bytes, fileName: file.name },
      open.means.codec
    ));
  } catch (error) {
    if (!(error instanceof UnreadableImageError)) {
      throw error;
    }
    return { name: file.name, reason: error.message };
  }
  const { photographs } = open.kept();
  const alreadyImported = photographs.some((known) => known.id === digest);
  const artifactId = await open.store.keepPhotograph({
    bytes: file.bytes,
    digest,
    fileName: file.name,
  });
  if (!alreadyImported) {
    open.keep({
      photographs: [
        ...photographs,
        { artifactId, fileName: file.name, id: digest },
      ],
    });
  }
  return { alreadyImported, artifactId, fileName: file.name };
};

/** Imports each file in turn. A file that cannot be read is named and the rest go on. */
export const importFiles = async (
  open: OpenProject,
  files: readonly GivenFile[]
): Promise<Imported> => {
  const fonts: ImportedFont[] = [];
  const photographs: ImportedPhotograph[] = [];
  const refused: Refused[] = [];
  for (const file of files) {
    if (photographTypeFor(file.name).startsWith("image/")) {
      const photograph = await importPhotograph(open, file);
      if ("reason" in photograph) {
        refused.push(photograph);
      } else {
        photographs.push(photograph);
      }
    } else {
      const font = await importFont(open, file);
      if ("reason" in font) {
        refused.push(font);
      } else {
        fonts.push(font);
      }
    }
  }
  return { fonts, photographs, refused };
};
