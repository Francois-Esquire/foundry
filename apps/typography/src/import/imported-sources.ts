/** What the import screen says about the source fonts in the project and about a finished import. */
import type { Imported } from "~/application/application";
import { count } from "~/lib/count";
import { type Face, faceStyleName, isVariable } from "~/typeface/face";
import type { TypefaceProject } from "~/typeface/project";
import { type SourceUsage, sourceUsage } from "~/typeface/removal";

export interface SourceRow {
  readonly byteLength: number;
  /** The faces read from the file, such as "Regular" or "Regular, variable". */
  readonly faces: string;
  /** Family names, usually one. */
  readonly family: string;
  readonly fileName: string;
  readonly sourceId: string;
  /** Work that would be lost with the font. */
  readonly usage: SourceUsage;
}

const describeFace = (face: Face) =>
  isVariable(face) ? `${faceStyleName(face)}, variable` : faceStyleName(face);

const describeFaces = (faces: readonly Face[]) => {
  const read = faces.filter((face) => !face.pinned).map(describeFace);
  const pinned = faces.filter((face) => face.pinned).length;
  return [read.join("; "), pinned > 0 && count(pinned, "pinned instance")]
    .filter(Boolean)
    .join("; ");
};

/** One row per source font, in the order they were imported. */
export const sourceRows = (project: TypefaceProject): SourceRow[] =>
  project.sources.map((source) => {
    const faces = project.faces.filter((face) => face.sourceId === source.id);
    return {
      byteLength: source.bytes.byteLength,
      faces: describeFaces(faces),
      family: [
        ...new Set(faces.map((face) => face.description.familyName)),
      ].join(", "),
      fileName: source.fileName,
      sourceId: source.id,
      usage: sourceUsage(project, source.id),
    };
  });

export const hasWork = (usage: SourceUsage) =>
  usage.appliedChanges + usage.proposedCandidates + usage.waitingRuns > 0;

/**
 * One sentence about a finished import. The reason each file was turned away
 * is in a notice of its own, which the shell shows above every place, so this
 * only counts them.
 */
export const summariseImport = ({ fonts, refused }: Imported): string => {
  const duplicates = fonts.filter((font) => font.alreadyImported).length;
  const imported = fonts.length - duplicates;
  const rejected = refused.length;
  return [
    `${count(imported, "font")} imported.`,
    duplicates > 0 &&
      `${count(duplicates, "file")} ${duplicates === 1 ? "was" : "were"} already in the project.`,
    rejected > 0 &&
      `${count(rejected, "file")} could not be read, for the reasons given above.`,
  ]
    .filter(Boolean)
    .join(" ");
};
