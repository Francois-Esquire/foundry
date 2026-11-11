/**
 * Resolves an export plan against a project: one output per face, with its
 * file name, and everything that is wrong or worth knowing, before any build
 * runs. Pure: the same project and plan always resolve the same way.
 */
import { glyphChangesOf, type WorkingFace } from "~/typeface/changes";
import {
  type AxisLocation,
  clampLocation,
  type Face,
  type FaceDescription,
  type FaceId,
} from "~/typeface/face";
import {
  findSource,
  isModified,
  type TypefaceProject,
  workingFaceOf,
} from "~/typeface/project";
import type { BuildRequest, SubsetSelection } from "./building";
import { formatCharacter, selectCharacters } from "./character-selection";
import type { CharacterLookups, ExportPlan, PlannedFace } from "./export-plan";
import { distinctFileNames, fontFileName } from "./file-names";
import {
  checkName,
  type Finding,
  type Findings,
  labelOf,
  type NameFindingCode,
  requestedFamilyName,
} from "./findings";

export type ExportFindingCode =
  | NameFindingCode
  | "no-faces"
  | "unknown-face"
  | "reconstructed-lettering"
  | "variable-has-changes"
  | "pinned-location-ignored"
  | "selector-matched-nothing"
  | "characters-missing"
  | "no-characters"
  | "features-missing"
  | "outlines-converted";

export type ExportFinding = Finding<ExportFindingCode>;

export type ExportOutput =
  | {
      /** The source file, byte for byte. Nothing is built. */
      readonly kind: "original";
      readonly bytes: Uint8Array;
      readonly faceId: FaceId;
      readonly fileName: string;
    }
  | {
      readonly kind: "derived";
      readonly faceId: FaceId;
      readonly fileName: string;
      readonly request: BuildRequest;
    };

export interface ExportResolution {
  readonly outputs: readonly ExportOutput[];
  /** Problems that block the export. Build nothing while there are any. */
  readonly problems: readonly ExportFinding[];
  readonly warnings: readonly ExportFinding[];
}

type ExportFindings = Findings<ExportFindingCode>;

interface Variation {
  readonly location?: AxisLocation;
  readonly styleName: string;
}

const LISTED_CHARACTERS = 5;
const FEATURE_BLOCK = /feature\s+(\w{1,4})\s*\{/g;
const VARIABLE_STYLE = "Variable";

const sameLocation = (a: AxisLocation, b: AxisLocation) =>
  Object.keys({ ...a, ...b }).every((tag) => a[tag] === b[tag]);

/** The named instance at a location, or the axis values spelled out. */
const instanceNameAt = (
  description: FaceDescription,
  location: AxisLocation
): string => {
  const named = description.instances.find((instance) =>
    sameLocation(clampLocation(description.axes, instance.location), location)
  );
  if (named) {
    return named.name;
  }
  const moved = description.axes.filter(
    (axis) => location[axis.tag] !== axis.default
  );
  return moved.length > 0
    ? moved.map((axis) => `${axis.tag}${location[axis.tag]}`).join(" ")
    : description.styleName;
};

/** Decides whether a face is exported variable or at one location. */
const variationOf = (
  face: Face,
  planned: PlannedFace,
  modified: boolean,
  findings: ExportFindings
): Variation => {
  const { description, id: faceId, pinned } = face;
  const treatment = planned.variable;
  if (description.axes.length === 0) {
    return { styleName: description.styleName };
  }
  if (pinned) {
    if (treatment?.kind === "keep-variable" && modified) {
      findings.problems.push({
        code: "variable-has-changes",
        faceId,
        message: `${labelOf(face)} has changes, and a changed face cannot stay variable. Export it at its pinned location, or undo its changes.`,
      });
    } else if (treatment?.kind === "keep-variable") {
      return { styleName: VARIABLE_STYLE };
    }
    if (
      treatment?.kind === "pinned" &&
      !sameLocation(
        clampLocation(description.axes, treatment.location),
        pinned.location
      )
    ) {
      findings.warnings.push({
        code: "pinned-location-ignored",
        faceId,
        message: `${labelOf(face)} is already pinned to one location, so it is exported there and the location in the plan is ignored.`,
      });
    }
    return { location: pinned.location, styleName: pinned.styleName };
  }
  if (treatment?.kind === "pinned") {
    const location = clampLocation(description.axes, treatment.location);
    return {
      location,
      styleName:
        treatment.styleName?.trim() || instanceNameAt(description, location),
    };
  }
  return { styleName: VARIABLE_STYLE };
};

/** Narrows the plan's characters to the ones this face can supply. */
const keptCharacters = (
  face: Face,
  working: WorkingFace,
  selected: ReadonlySet<number>,
  lookups: CharacterLookups,
  findings: ExportFindings
): number[] => {
  const available = new Set([
    ...lookups.charactersOfFace(face.id),
    ...working.characters.keys(),
  ]);
  const kept: number[] = [];
  const missing: number[] = [];
  for (const character of selected) {
    (available.has(character) ? kept : missing).push(character);
  }
  if (selected.size > 0 && kept.length === 0) {
    findings.problems.push({
      code: "no-characters",
      faceId: face.id,
      message: `${labelOf(face)} has none of the selected characters. Select characters this face has, or leave it out of the export.`,
    });
  } else if (missing.length > 0) {
    const listed = missing
      .toSorted((a, b) => a - b)
      .slice(0, LISTED_CHARACTERS)
      .map(formatCharacter)
      .join(", ");
    const more = missing.length > LISTED_CHARACTERS ? " and others" : "";
    findings.warnings.push({
      code: "characters-missing",
      faceId: face.id,
      message: `${labelOf(face)} does not have ${missing.length} of the ${selected.size} selected characters (${listed}${more}). They are left out of its file.`,
    });
  }
  return kept.sort((a, b) => a - b);
};

const featuresOf = (face: Face, working: WorkingFace): Set<string> => {
  const { positioning, substitution } = face.description.layout;
  const written = working.featureCode.flatMap((code) =>
    [...code.matchAll(FEATURE_BLOCK)].map((match) => match[1] ?? "")
  );
  return new Set([...positioning, ...substitution, ...written]);
};

const keptFeatures = (
  face: Face,
  working: WorkingFace,
  tags: readonly string[],
  findings: ExportFindings
): string[] => {
  const present = featuresOf(face, working);
  const kept = [...new Set(tags)];
  const absent = kept.filter((tag) => !present.has(tag));
  if (absent.length > 0) {
    findings.warnings.push({
      code: "features-missing",
      faceId: face.id,
      message: `${labelOf(face)} has no feature named ${absent.join(", ")}, so nothing is kept for it.`,
    });
  }
  return kept;
};

interface PlanWide {
  readonly familyName?: string;
  readonly lookups: CharacterLookups;
  readonly plan: ExportPlan;
  readonly project: TypefaceProject;
  /** Undefined when the plan keeps every character. */
  readonly selected?: ReadonlySet<number>;
}

const resolveFace = (
  face: Face,
  planned: PlannedFace,
  shared: PlanWide,
  findings: ExportFindings
): ExportOutput => {
  const { familyName, lookups, plan, project, selected } = shared;
  const { description, id: faceId } = face;
  const source = findSource(project, face.sourceId);
  const working = workingFaceOf(project, faceId);
  const modified = isModified(project, faceId);
  const variation = variationOf(face, planned, modified, findings);
  const subset: SubsetSelection | undefined =
    selected || plan.features.kind === "chosen"
      ? {
          characters:
            selected &&
            keptCharacters(face, working, selected, lookups, findings),
          features:
            plan.features.kind === "chosen"
              ? keptFeatures(face, working, plan.features.tags, findings)
              : undefined,
        }
      : undefined;
  const renamed =
    familyName !== undefined && familyName !== description.familyName;
  const derived =
    modified ||
    variation.location !== undefined ||
    subset !== undefined ||
    renamed ||
    plan.format !== "ttf";
  if (!derived) {
    return {
      bytes: source.bytes,
      faceId,
      fileName: source.fileName,
      kind: "original",
    };
  }
  const outputFamily = familyName ?? description.familyName;
  const reconstructed = source.madeFor === "reconstruction";
  if (reconstructed) {
    // The one thing true of a font the app made from a photograph: nobody can
    // tell from here whose lettering was photographed.
    findings.warnings.push({
      code: "reconstructed-lettering",
      faceId,
      message: `The letters of ${labelOf(face)} were reconstructed from a photograph. This app cannot know whether that lettering is a typeface someone owns. Check before you distribute the font.`,
    });
  }
  checkName(
    {
      faceId,
      familyName: outputFamily,
      made: "derived",
      madeHere: reconstructed,
      source: description,
      subset: subset !== undefined,
    },
    findings
  );
  const redrawn = working.overrides.size > 0 || working.added.length > 0;
  const postScript =
    description.outlineFormat === "cff" || description.outlineFormat === "cff2";
  if (postScript && redrawn) {
    findings.warnings.push({
      code: "outlines-converted",
      faceId,
      message: `${labelOf(face)} has PostScript outlines and changed glyphs, so its outlines are converted to TrueType in the derived font.`,
    });
  }
  return {
    faceId,
    fileName: fontFileName({
      familyName: outputFamily,
      flavor: plan.format,
      postScriptOutlines: postScript && !redrawn,
      styleName: variation.styleName,
      subset: subset !== undefined,
    }),
    kind: "derived",
    request: {
      ...glyphChangesOf(working),
      faceIndex: face.index,
      familyName,
      flavor: plan.format,
      location: variation.location,
      source: source.bytes,
      styleName: variation.location ? variation.styleName : undefined,
      subset,
    },
  };
};

const planWide = (
  project: TypefaceProject,
  plan: ExportPlan,
  lookups: CharacterLookups,
  findings: ExportFindings
): PlanWide => {
  const familyName = requestedFamilyName(
    plan.familyName,
    "each face's own",
    findings
  );
  if (plan.faces.length === 0) {
    findings.problems.push({
      code: "no-faces",
      message: "The plan has no faces. Choose at least one face to export.",
    });
  }
  if (plan.characters.kind === "everything") {
    return { familyName, lookups, plan, project };
  }
  const { characters, empty } = selectCharacters(
    plan.characters.selectors,
    lookups
  );
  for (const selector of empty) {
    findings.warnings.push({
      code: "selector-matched-nothing",
      message: `Nothing matched ${selector}. Check the selection.`,
    });
  }
  if (characters.size === 0) {
    findings.problems.push({
      code: "no-characters",
      message:
        "The plan selects no characters. Add characters, a script, a block or a language, or export everything.",
    });
  }
  return { familyName, lookups, plan, project, selected: characters };
};

export const resolveExportPlan = (
  project: TypefaceProject,
  plan: ExportPlan,
  lookups: CharacterLookups
): ExportResolution => {
  const findings: ExportFindings = { problems: [], warnings: [] };
  const shared = planWide(project, plan, lookups, findings);
  const outputs: ExportOutput[] = [];
  const planned = new Map(plan.faces.map((entry) => [entry.faceId, entry]));
  for (const entry of planned.values()) {
    const face = project.faces.find((known) => known.id === entry.faceId);
    if (face) {
      outputs.push(resolveFace(face, entry, shared, findings));
    } else {
      findings.problems.push({
        code: "unknown-face",
        faceId: entry.faceId,
        message: `The plan names a face this project does not have (${entry.faceId}). Remove it from the plan.`,
      });
    }
  }
  const fileNames = distinctFileNames(outputs.map((output) => output.fileName));
  return {
    outputs: outputs.map((output, index) => ({
      ...output,
      fileName: fileNames[index] ?? output.fileName,
    })),
    problems: findings.problems,
    warnings: findings.warnings,
  };
};
