import {
  MODULE_MANIFEST_SOURCE_PATH,
  parseModuleManifestSourceText,
} from "./manifest";
import {
  admitModuleSource,
  MODULE_SOURCE_LIMITS,
  type ModuleSourceLimits,
} from "./source-admission";

export type ModuleSourceChanges = Record<string, string | null>;

export function moduleSourceChanges(
  snapshot: Readonly<Record<string, string>>,
  proposed: Readonly<Record<string, string>>
): ModuleSourceChanges {
  const changes: [string, string | null][] = [];
  for (const path of new Set([
    ...Object.keys(snapshot),
    ...Object.keys(proposed),
  ])) {
    const after = Object.hasOwn(proposed, path) ? proposed[path] : null;
    const before = Object.hasOwn(snapshot, path) ? snapshot[path] : null;
    if (after !== before) {
      changes.push([path, after ?? null]);
    }
  }
  return Object.fromEntries(changes);
}

export function applyModuleSourceChanges(
  source: Readonly<Record<string, string>>,
  changes: Readonly<ModuleSourceChanges>
): Record<string, string> {
  const next = new Map(Object.entries(source));
  for (const [path, value] of Object.entries(changes)) {
    if (value === null) {
      next.delete(path);
    } else {
      next.set(path, value);
    }
  }
  return Object.fromEntries(next);
}

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
