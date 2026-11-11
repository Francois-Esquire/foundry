/**
 * Resolves pinned instances of one variable face into a request to rebuild a
 * variable font from them, with everything that is wrong or worth knowing,
 * before the engine runs. Pure: the same project always resolves the same way.
 *
 * Whether the masters' glyphs match is the engine's to say. It builds each
 * master first, and names the glyph that differs.
 */
import { glyphChangesOf } from "~/typeface/changes";
import type { Face, FaceId } from "~/typeface/face";
import {
  findSource,
  type TypefaceProject,
  workingFaceOf,
} from "~/typeface/project";
import type { FontFlavor, VariableBuildRequest } from "./building";
import { fontFileName } from "./file-names";
import {
  checkName,
  type Finding,
  type Findings,
  labelOf,
  type NameFindingCode,
  requestedFamilyName,
} from "./findings";

type VariableBuildFindingCode =
  | NameFindingCode
  | "too-few-masters"
  | "unknown-face"
  | "not-pinned"
  | "several-sources"
  | "several-axes";

type VariableBuildFinding = Finding<VariableBuildFindingCode>;
type VariableBuildFindings = Findings<VariableBuildFindingCode>;

export interface VariableBuildOptions {
  /** The family name of the rebuilt font. Omit to keep the source's own. */
  readonly familyName?: string;
  readonly flavor?: FontFlavor;
}

export interface VariableBuildResolution {
  readonly fileName: string;
  /** Problems that block the build. There is no request while there are any. */
  readonly problems: readonly VariableBuildFinding[];
  readonly request?: VariableBuildRequest;
  readonly warnings: readonly VariableBuildFinding[];
}

type PinnedFace = Face & { readonly pinned: NonNullable<Face["pinned"]> };

/**
 * The style in the file name. An unchanged variable face kept variable is
 * exported as Family-Variable, so the rebuilt font takes a name of its own
 * and the two never overwrite each other in a downloads folder.
 */
const REBUILT_STYLE = "Variable Rebuilt";

/** The faces that can be masters: known to the project and pinned. */
const pinnedFaces = (
  project: TypefaceProject,
  faceIds: readonly FaceId[],
  findings: VariableBuildFindings
): PinnedFace[] => {
  const masters: PinnedFace[] = [];
  for (const faceId of new Set(faceIds)) {
    const face = project.faces.find((known) => known.id === faceId);
    if (!face) {
      findings.problems.push({
        code: "unknown-face",
        faceId,
        message: `This project has no face ${faceId}. Remove it from the masters.`,
      });
    } else if (face.pinned) {
      masters.push({ ...face, pinned: face.pinned });
    } else {
      findings.problems.push({
        code: "not-pinned",
        faceId,
        message: `${labelOf(face)} is not a pinned instance. A master is a pinned instance of a variable face.`,
      });
    }
  }
  return masters;
};

/**
 * Masters have to come from one source and lie along one axis. Two pinned
 * instances of a face are never at one location: pinning the same location
 * again returns the face that is already there.
 */
const checkPlaces = (
  masters: readonly PinnedFace[],
  findings: VariableBuildFindings
) => {
  const [first, ...others] = masters;
  if (!first || others.length === 0) {
    findings.problems.push({
      code: "too-few-masters",
      message:
        "A variable font needs at least two masters. Pin another instance of the variable face.",
    });
    return;
  }
  const stranger = others.find(
    (face) => face.sourceId !== first.sourceId || face.index !== first.index
  );
  if (stranger) {
    findings.problems.push({
      code: "several-sources",
      faceId: stranger.id,
      message: `${labelOf(stranger)} and ${labelOf(first)} come from different source fonts. Masters are pinned instances of one variable face.`,
    });
    return;
  }
  const tags = first.description.axes.map((axis) => axis.tag);
  const moving = tags.filter((tag) =>
    others.some(
      (face) => face.pinned.location[tag] !== first.pinned.location[tag]
    )
  );
  if (moving.length > 1) {
    findings.problems.push({
      code: "several-axes",
      message: `The masters differ on more than one axis (${moving.join(", ")}). Pin them along one axis and keep the others the same.`,
    });
  }
};

/** The rebuilt font's family name, with what that name and the source's licence mean for it. */
const familyNameOf = (
  first: PinnedFace,
  options: VariableBuildOptions,
  findings: VariableBuildFindings
): string => {
  const familyName =
    requestedFamilyName(options.familyName, "the source's", findings) ??
    first.description.familyName;
  checkName(
    { familyName, made: "rebuilt", source: first.description, subset: false },
    findings
  );
  return familyName;
};

export const resolveVariableBuild = (
  project: TypefaceProject,
  faceIds: readonly FaceId[],
  options: VariableBuildOptions = {}
): VariableBuildResolution => {
  const findings: VariableBuildFindings = { problems: [], warnings: [] };
  const masters = pinnedFaces(project, faceIds, findings);
  checkPlaces(masters, findings);
  const [first] = masters;
  const flavor = options.flavor ?? "ttf";
  const familyName = first ? familyNameOf(first, options, findings) : "";
  const fileName = fontFileName({
    familyName,
    flavor,
    postScriptOutlines: false,
    styleName: REBUILT_STYLE,
    subset: false,
  });
  if (!first || findings.problems.length > 0) {
    return { fileName, ...findings };
  }
  return {
    fileName,
    ...findings,
    request: {
      faceIndex: first.index,
      familyName: options.familyName?.trim(),
      flavor,
      masters: masters.map((face) => ({
        ...glyphChangesOf(workingFaceOf(project, face.id)),
        location: face.pinned.location,
        styleName: face.pinned.styleName,
      })),
      source: findSource(project, first.sourceId).bytes,
    },
  };
};
