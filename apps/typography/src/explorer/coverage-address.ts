import type { Scope } from "~/unicode/scope";
import { findScript, sharedGroups } from "~/unicode/scripts";
/** The Coverage place without a selected scope. */
export const COVERAGE_ADDRESS = "#/coverage";

/** The address segment that names a scope: Deva, or shared.digits. */
export const scopeKey = (scope: Scope): string => {
  if (scope.kind === "script") {
    return scope.code;
  }
  return scope.kind === "shared" ? `${SHARED_PREFIX}${scope.group}` : "";
};

const SHARED_PREFIX = "shared.";

/** Reads an address segment back into its scope. Undefined for a name no writing system has. */
export const scopeOfKey = (key: string | undefined): Scope | undefined => {
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

/** The address of a scope in the coverage explorer. */
export const coverageAddress = (scope: Scope) =>
  `${COVERAGE_ADDRESS}/${encodeURIComponent(scopeKey(scope))}`;
