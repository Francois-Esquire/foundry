/**
 * The export plan as it is being chosen on screen. A draft is plain state; it
 * becomes an export plan only through `planOf`, and `resolveDraft` is how the
 * Export screen and the export command both have packaging resolve it.
 */
import type { FontFlavor } from "~/packaging/building";
import type {
  CharacterLookups,
  CharacterSelector,
  ExportPlan,
  VariableTreatment,
} from "~/packaging/export-plan";
import {
  type ExportResolution,
  resolveExportPlan,
} from "~/packaging/resolving";
import type { FaceId } from "~/typeface/face";
import type { TypefaceProject } from "~/typeface/project";
import { charactersIn } from "~/unicode/scope";
import type { SharedGroupId } from "~/unicode/scripts";
import { charactersTyped } from "~/unicode/typed-characters";
import { readRanges } from "./typed-ranges";

export interface PlanDraft {
  /** Unicode block names. */
  readonly blocks: readonly string[];
  readonly faceIds: readonly FaceId[];
  /** As typed. Empty keeps each face's own family name. */
  readonly familyName: string;
  readonly features: "needed" | "chosen";
  readonly featureTags: readonly string[];
  readonly format: FontFlavor;
  readonly keep: "everything" | "selection";
  /** BCP 47 language tags. */
  readonly languages: readonly string[];
  /** Code points and ranges, as typed. */
  readonly ranges: string;
  /** ISO 15924 script codes. */
  readonly scripts: readonly string[];
  /** Digits, punctuation and the other characters scripts share. */
  readonly sharedGroups: readonly SharedGroupId[];
  /** How each variable source is exported, for the faces that have a choice. */
  readonly treatments: Readonly<Record<FaceId, VariableTreatment>>;
  /** Characters to keep, as typed. */
  readonly typed: string;
}

/** A plan that exports one face whole, as a TrueType file, under its own name. */
export const startDraft = (faceId: FaceId | undefined): PlanDraft => ({
  blocks: [],
  faceIds: faceId === undefined ? [] : [faceId],
  familyName: "",
  features: "needed",
  featureTags: [],
  format: "ttf",
  keep: "everything",
  languages: [],
  ranges: "",
  scripts: [],
  sharedGroups: [],
  treatments: {},
  typed: "",
});

/** Adds the value when it is absent and removes it when it is present. */
export const toggled = <Value>(
  values: readonly Value[],
  value: Value,
  on: boolean
): Value[] => {
  const without = values.filter((existing) => existing !== value);
  return on ? [...without, value] : without;
};

const selectorsOf = (draft: PlanDraft): CharacterSelector[] => {
  const typed = charactersTyped(draft.typed);
  return [
    ...draft.scripts.map(
      (script): CharacterSelector => ({ kind: "script", script })
    ),
    // A shared group is not a script, so it is named character by character.
    ...draft.sharedGroups.map(
      (group): CharacterSelector => ({
        codePoints: [...charactersIn({ group, kind: "shared" })],
        kind: "characters",
      })
    ),
    ...draft.blocks.map(
      (block): CharacterSelector => ({ block, kind: "block" })
    ),
    ...draft.languages.map(
      (language): CharacterSelector => ({ kind: "language", language })
    ),
    ...(typed.length > 0
      ? [{ codePoints: typed, kind: "characters" } as const]
      : []),
    ...readRanges(draft.ranges).selectors,
  ];
};

export interface DraftedPlan {
  readonly plan: ExportPlan;
  /** Problems in what was typed, which the plan itself cannot carry. */
  readonly problems: readonly string[];
}

const typingProblems = (draft: PlanDraft): string[] => {
  const { unreadable } = readRanges(draft.ranges);
  if (draft.keep !== "selection" || unreadable.length === 0) {
    return [];
  }
  return [
    `${unreadable.map((piece) => `"${piece}"`).join(", ")} ${unreadable.length === 1 ? "is" : "are"} not a code point or a range. Write code points as U+0041 and ranges as U+0041-U+005A, with commas between them.`,
  ];
};

/**
 * The export plan a draft stands for. Faces that have left the project are
 * left out, so a draft kept from earlier never names a font that is gone.
 */
export const planOf = (
  draft: PlanDraft,
  project: TypefaceProject
): DraftedPlan => {
  const present = new Set(project.faces.map((face) => face.id));
  const familyName = draft.familyName.trim();
  return {
    plan: {
      characters:
        draft.keep === "everything"
          ? { kind: "everything" }
          : { kind: "selected", selectors: selectorsOf(draft) },
      faces: draft.faceIds
        .filter((faceId) => present.has(faceId))
        .map((faceId) => ({ faceId, variable: draft.treatments[faceId] })),
      familyName: familyName === "" ? undefined : familyName,
      features:
        draft.features === "needed"
          ? { kind: "needed" }
          : { kind: "chosen", tags: draft.featureTags },
      format: draft.format,
    },
    problems: typingProblems(draft),
  };
};

export interface ResolvedDraft {
  /** What packaging will build, with its own problems and warnings. */
  readonly resolution: ExportResolution;
  /** Problems in what was typed, which the plan itself cannot carry. */
  readonly typingProblems: readonly string[];
}

/** A draft as packaging resolves it against the project. */
export const resolveDraft = (
  project: TypefaceProject,
  draft: PlanDraft,
  lookups: CharacterLookups
): ResolvedDraft => {
  const { plan, problems } = planOf(draft, project);
  return {
    resolution: resolveExportPlan(project, plan, lookups),
    typingProblems: problems,
  };
};
