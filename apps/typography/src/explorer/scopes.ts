/**
 * The writing systems the explorer can show, and the address that names one.
 * Every script and shared group comes from the Unicode data, so none needs
 * code of its own here.
 */
import { scopeKey } from "~/library/composition";
import { type Scope, scopeName } from "~/unicode/scope";
import {
  featuredScripts,
  findScript,
  scripts,
  sharedGroups,
} from "~/unicode/scripts";

const SHARED_PREFIX = "shared.";

/** Reads the address segment for a scope: Deva, or shared.digits. */
export const scopeFromKey = (key: string | undefined): Scope | undefined => {
  if (key === undefined) {
    return;
  }
  if (key.startsWith(SHARED_PREFIX)) {
    const group = sharedGroups().find(
      (candidate) => candidate.id === key.slice(SHARED_PREFIX.length)
    );
    return group && { group: group.id, kind: "shared" };
  }
  const script = findScript(key);
  return script && { code: script.code, kind: "script" };
};

export interface ScopeOption {
  readonly label: string;
  readonly value: string;
}

/** Every writing system: the featured six, the shared groups, then the rest by name. */
export const scopeOptions = (): ScopeOption[] => {
  const featured = featuredScripts();
  const featuredCodes = new Set(featured.map((script) => script.code));
  const scopes: Scope[] = [
    ...featured.map((script): Scope => ({ code: script.code, kind: "script" })),
    ...sharedGroups().map(
      (group): Scope => ({ group: group.id, kind: "shared" })
    ),
    ...scripts()
      .filter((script) => !featuredCodes.has(script.code))
      .map((script): Scope => ({ code: script.code, kind: "script" })),
  ];
  return scopes.map((scope) => ({
    label: scopeName(scope),
    value: scopeKey(scope),
  }));
};
