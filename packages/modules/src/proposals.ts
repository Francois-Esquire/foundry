import {
  MODULE_MANIFEST_SOURCE_PATH,
  parseModuleManifestSourceText,
} from "./manifest";
import {
  admitModuleSource,
  MODULE_SOURCE_LIMITS,
  type ModuleSourceLimits,
} from "./source";

/**
 * Proposed edits to Module source, whole files at a time: each changed path
 * maps to its new text, or `null` where the file is removed. A proposal is
 * made against a snapshot of source and is applied only by whoever owns
 * that source; nothing here saves.
 */
export type ModuleSourceChanges = Record<string, string | null>;

/** Each path whose `proposed` text differs from `snapshot`; `null` where it was removed. */
export function moduleSourceChanges(
  snapshot: Readonly<Record<string, string>>,
  proposed: Readonly<Record<string, string>>
): ModuleSourceChanges {
  const changes: ModuleSourceChanges = {};
  for (const path of new Set([
    ...Object.keys(snapshot),
    ...Object.keys(proposed),
  ])) {
    const after = Object.hasOwn(proposed, path) ? proposed[path] : null;
    const before = Object.hasOwn(snapshot, path) ? snapshot[path] : null;
    if (after !== before) {
      changes[path] = after ?? null;
    }
  }
  return changes;
}

/** `source` with `changes` applied: `null` removes a file. */
export function applyModuleSourceChanges(
  source: Readonly<Record<string, string>>,
  changes: Readonly<ModuleSourceChanges>
): Record<string, string> {
  const next = { ...source };
  for (const [path, value] of Object.entries(changes)) {
    if (value === null) {
      delete next[path];
    } else {
      next[path] = value;
    }
  }
  return next;
}

/**
 * Admits a proposal the way saved source is admitted: portable paths and
 * the source limits over the files it would produce, and a Manifest that
 * still parses when the proposal changes it. Throws on the first problem.
 */
export function validateModuleSourceProposal(
  snapshot: Readonly<Record<string, string>>,
  changes: Readonly<ModuleSourceChanges>,
  limits: ModuleSourceLimits = MODULE_SOURCE_LIMITS
): void {
  admitModuleSource(applyModuleSourceChanges(snapshot, changes), limits);
  if (!Object.hasOwn(changes, MODULE_MANIFEST_SOURCE_PATH)) {
    return;
  }
  const manifest = changes[MODULE_MANIFEST_SOURCE_PATH];
  if (typeof manifest !== "string") {
    throw new Error(`The proposal removes ${MODULE_MANIFEST_SOURCE_PATH}.`);
  }
  try {
    parseModuleManifestSourceText(manifest);
  } catch (error) {
    throw new Error(
      `The proposed ${MODULE_MANIFEST_SOURCE_PATH} is not a valid Manifest: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}
