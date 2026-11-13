/** The characters a draft names, the request it makes, and whether it can run. */
import type { StrategyOption } from "~/generation/strategies/offering";
import type { RecordedEntry } from "~/generation/strategies/recorded/catalogue";
import type { Availability } from "~/generation/strategies/strategy";
import type { Face } from "~/typeface/face";
import type { Classifier } from "~/unicode/coverage";
import type { Language } from "~/unicode/languages";
import { readTypedCharacters } from "~/unicode/typed-characters";
import type { CatalogueState } from "~/workspace/recorded-catalogue";
import {
  missingForLanguage,
  missingInScope,
  scopeFromKey,
} from "./missing-characters";
import type { RequestPlan } from "./request-plan";
import type { RunRequest } from "./running";
import type { Draft } from "./session";

/** Whether a run can start, and the reason when it cannot. */
export type Readiness =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: string };

export const namedCharacters = (
  draft: Draft,
  classify: Classifier,
  languages: readonly Language[] | undefined
): readonly number[] => {
  if (draft.source === "typed") {
    return readTypedCharacters(draft.typed);
  }
  if (draft.source === "script") {
    const scope = scopeFromKey(draft.scope);
    return scope ? missingInScope(scope, classify) : [];
  }
  const language = languages?.find((known) => known.tag === draft.language);
  return language ? missingForLanguage(language, classify) : [];
};

/**
 * Whether a replay can run. A catalogue with no entry and a catalogue with
 * none chosen are told apart: only the second is something a person can fix.
 */
export const recordedAvailability = (
  catalogue: CatalogueState,
  chosen: boolean
): Availability => {
  if (catalogue.status === "failed") {
    return {
      available: false,
      reason: "The recorded runs could not be listed.",
    };
  }
  if (catalogue.status !== "listed") {
    return { available: false, reason: "The recorded runs are being listed." };
  }
  return chosen
    ? { available: true }
    : {
        available: false,
        reason:
          catalogue.catalogue.entries.length === 0
            ? "No recorded run is served with this app."
            : "Choose a recorded run to replay.",
      };
};

export const requestOf = (
  face: Face,
  draft: Draft,
  characters: readonly number[],
  plan: RequestPlan,
  recorded: RecordedEntry | undefined
): RunRequest | undefined => {
  if (draft.strategy === "recorded-run") {
    return { entry: recorded, faceId: face.id, kind: "recorded" };
  }
  return plan.targets.length > 0
    ? {
        characters,
        faceId: face.id,
        kind: "characters",
        strategy: draft.strategy,
      }
    : undefined;
};

export const readinessOf = (
  option: StrategyOption | undefined,
  request: RunRequest | undefined,
  draft: Draft,
  noRule: number
): Readiness => {
  if (option && !option.availability.available) {
    return { ready: false, reason: option.availability.reason };
  }
  return request
    ? { ready: true }
    : { ready: false, reason: emptyReason(draft, noRule) };
};

const missingCharacters = (count: number) =>
  count === 1 ? "1 missing character" : `${count} missing characters`;

/**
 * What to say about missing characters the procedural strategy was not asked
 * for, because no rule can build them from glyphs the face has.
 */
export const noRuleNote = (noRule: number): string =>
  `No rule can build ${missingCharacters(noRule)} from glyphs the face has, so the procedural strategy is not asked for ${noRule === 1 ? "it" : "them"}. ${noRule === 1 ? "It has" : "They have"} to be drawn: choose a model strategy or a recorded run for ${noRule === 1 ? "it" : "them"}.`;

/**
 * Why a request holds nothing to generate, with what to do about it.
 * `noRule` counts the missing characters left out because no rule builds them.
 */
export const emptyReason = (draft: Draft, noRule = 0): string => {
  if (draft.source === "typed") {
    return "Type the characters to generate.";
  }
  if (draft.source === "language" && draft.language === "") {
    return "Choose a language.";
  }
  return noRule > 0
    ? `No rule can build any of the ${missingCharacters(noRule)} from glyphs the face has. Choose a strategy that draws.`
    : "The face lacks none of these characters, so there is nothing to generate.";
};

export const ruleSummary = (ruled: number, targets: number): string => {
  if (targets === 0) {
    return "Choose characters above to see which of them a rule can build.";
  }
  if (ruled === targets) {
    return targets === 1
      ? "A rule can build this target from glyphs the face has."
      : `A rule can build all ${targets} targets from glyphs the face has.`;
  }
  return `A rule can build ${ruled} of the ${targets} targets. The others have to be drawn, and the run says so for each.`;
};
