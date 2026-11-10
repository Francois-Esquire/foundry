/** Which characters a face lacks, in a writing system or for a language. */
import type { Classifier } from "~/unicode/coverage";
import type { Language } from "~/unicode/languages";
import { charactersIn, type Scope, scopeName } from "~/unicode/scope";
import {
  featuredScripts,
  findScript,
  scripts,
  sharedGroups,
} from "~/unicode/scripts";

const isMissing = (classify: Classifier) => (character: number) =>
  classify(character) === "missing";

/**
 * The characters of a writing system that the face lacks and no candidate
 * offers yet, in code point order.
 */
export const missingInScope = (scope: Scope, classify: Classifier): number[] =>
  [...charactersIn(scope)].filter(isMissing(classify));

/** A language's missing characters: the ones everyday text needs first, then the auxiliary ones. */
export const missingForLanguage = (
  language: Language,
  classify: Classifier
): number[] => [
  ...[...language.required].filter(isMissing(classify)),
  ...[...language.auxiliary].filter(isMissing(classify)),
];

const SCRIPT_PREFIX = "script:";
const SHARED_PREFIX = "shared:";

export const DEFAULT_SCOPE_KEY = `${SCRIPT_PREFIX}Latn`;

/** The value of the option for a writing system. Undefined for a scope that is not one. */
export const scopeOptionKey = (scope: Scope): string | undefined => {
  if (scope.kind === "script") {
    return `${SCRIPT_PREFIX}${scope.code}`;
  }
  return scope.kind === "shared" ? `${SHARED_PREFIX}${scope.group}` : undefined;
};

/** Reads the value of a writing system option back into its scope. */
export const scopeFromKey = (key: string): Scope | undefined => {
  if (key.startsWith(SCRIPT_PREFIX)) {
    const script = findScript(key.slice(SCRIPT_PREFIX.length));
    return script && { code: script.code, kind: "script" };
  }
  const group = sharedGroups().find(
    (candidate) => `${SHARED_PREFIX}${candidate.id}` === key
  );
  return group && { group: group.id, kind: "shared" };
};

/** Every writing system as an option: the featured scripts, the shared groups, then the rest. */
export const scopeOptions = (): {
  readonly label: string;
  readonly value: string;
}[] => {
  const featured = featuredScripts();
  const featuredCodes = new Set(featured.map(({ code }) => code));
  const option = (code: string) => ({
    label: scopeName({ code, kind: "script" }),
    value: `${SCRIPT_PREFIX}${code}`,
  });
  return [
    ...featured.map(({ code }) => option(code)),
    ...sharedGroups().map((group) => ({
      label: group.name,
      value: `${SHARED_PREFIX}${group.id}`,
    })),
    ...scripts()
      .filter(({ code }) => !featuredCodes.has(code))
      .map(({ code }) => option(code)),
  ];
};
