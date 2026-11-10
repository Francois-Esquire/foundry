/**
 * The plan of one variable font, before the engine runs: what packaging
 * resolves from the masters, and a check packaging leaves to the engine,
 * made here first so a glyph that cannot interpolate blocks the build with
 * its reason instead of failing eleven seconds in. The engine still has the
 * last word.
 */
import { compatibilityOf } from "~/generation/family/compatibility";
import type { VariableBuildRequest } from "~/packaging/building";
import {
  resolveVariableBuild,
  type VariableBuildOptions,
} from "~/packaging/variable-build";
import type { AddedGlyph } from "~/typeface/changes";
import { type Face, type FaceId, faceStyleName } from "~/typeface/face";
import { type TypefaceProject, workingFaceOf } from "~/typeface/project";
import { weightOf } from "./masters";

export interface MasterFacts {
  /** Glyphs the project added to this instance. */
  readonly added: number;
  readonly faceId: FaceId;
  /** Source glyphs this instance redraws or respaces. */
  readonly overridden: number;
  readonly styleName: string;
  readonly weight: number | undefined;
}

export interface VariablePlan {
  readonly fileName: string;
  /** The chosen masters, lightest first. */
  readonly masters: readonly MasterFacts[];
  /** Each blocks the build and says why. */
  readonly problems: readonly string[];
  /** Absent while there is a problem. */
  readonly request?: VariableBuildRequest;
  readonly warnings: readonly string[];
}

/** How many glyph names a message lists before it says there are more. */
const LISTED = 6;

const listed = (names: readonly string[]) =>
  names.length > LISTED
    ? `${names.slice(0, LISTED).join(", ")} and ${names.length - LISTED} more`
    : names.join(", ");

interface Master {
  readonly added: ReadonlyMap<string, AddedGlyph>;
  readonly label: string;
}

/** A master without a glyph the others added cannot be merged with them. */
const absences = (masters: readonly Master[], names: readonly string[]) =>
  masters.flatMap(({ added, label }) => {
    const absent = names.filter((name) => !added.has(name));
    return absent.length > 0
      ? [
          `${label} lacks ${absent.length === 1 ? "an added glyph" : `${absent.length} added glyphs`} the other masters have: ${listed(absent)}. Every master needs the same added glyphs. Accept ${absent.length === 1 ? "it" : "them"} for ${label} too, or leave ${label} out of the masters.`,
        ]
      : [];
  });

/** Added glyphs every master has, drawn in ways that cannot interpolate. */
const mismatches = (masters: readonly Master[], names: readonly string[]) => {
  const found: string[] = [];
  for (const name of names) {
    const drawings = masters.flatMap(({ added, label }) => {
      const glyph = added.get(name);
      return glyph ? [{ label, outline: glyph.outline }] : [];
    });
    if (drawings.length < masters.length) {
      continue;
    }
    const { compatible, reason } = compatibilityOf(drawings);
    if (!compatible) {
      found.push(
        `The glyph ${name} cannot interpolate. ${reason ?? ""} Redraw it so every master has the same contours and points, or remove it from the masters.`
      );
    }
  }
  return found.length > LISTED
    ? [
        ...found.slice(0, LISTED),
        `${found.length - LISTED} more added glyphs cannot interpolate for the same kind of reason.`,
      ]
    : found;
};

/** Compares the glyphs the project added to each master, by glyph name. */
const glyphProblems = (
  project: TypefaceProject,
  faces: readonly Face[]
): string[] => {
  const masters = faces.map((face) => ({
    added: new Map(
      workingFaceOf(project, face.id).added.map((glyph) => [glyph.name, glyph])
    ),
    label: faceStyleName(face),
  }));
  const names = [...new Set(masters.flatMap(({ added }) => [...added.keys()]))];
  return [...absences(masters, names), ...mismatches(masters, names)];
};

/** What each pinned instance carries, in the order given. */
export const masterFactsOf = (
  project: TypefaceProject,
  faces: readonly Face[]
): MasterFacts[] =>
  faces.map((face) => {
    const working = workingFaceOf(project, face.id);
    return {
      added: working.added.length,
      faceId: face.id,
      overridden: working.overrides.size,
      styleName: faceStyleName(face),
      weight: weightOf(face),
    };
  });

export const planVariableFont = (
  project: TypefaceProject,
  faceIds: readonly FaceId[],
  options: VariableBuildOptions
): VariablePlan => {
  const resolution = resolveVariableBuild(project, faceIds, options);
  const faces = project.faces
    .filter((face) => face.pinned && faceIds.includes(face.id))
    .toSorted((a, b) => (weightOf(a) ?? 0) - (weightOf(b) ?? 0));
  const problems = [
    ...resolution.problems.map((problem) => problem.message),
    ...(faces.length > 1 ? glyphProblems(project, faces) : []),
  ];
  return {
    fileName: resolution.fileName,
    masters: masterFactsOf(project, faces),
    problems,
    request: problems.length > 0 ? undefined : resolution.request,
    warnings: resolution.warnings.map((warning) => warning.message),
  };
};
