/**
 * The dependency and vocabulary boundary for Modules.
 *
 * This is deliberately an internal policy module. Each source module owns its
 * own API; this module only keeps their shared architectural constraints
 * explicit and mechanically testable. `src/test/module-boundary.test.ts` runs
 * every production import through `isModuleAllowedImport`.
 */
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const MODULE_NOUNS = [
  "Module",
  "Artifact",
  "Version",
  "Installation",
  "Program",
  "ModuleGateway",
  "Capability",
  "Grant",
  "Binding",
  "Invocation",
] as const;

export const MODULE_ALLOWED_PACKAGE_IMPORTS = [
  "@foundry/artifacts",
  "@foundry/core/storage",
  "@foundry/core/pagination",
  "@foundry/lib/digest",
  "@foundry/lib/encoding",
  "@foundry/lib/json",
  "@foundry/lib/ordering",
  "@foundry/lib/pagination",
  "node:async_hooks",
  "typescript",
  "zod",
] as const;

/**
 * Platform takes Sandbox types only: it never constructs a backend. Imports
 * from these specifiers must be type-only, and each must match exactly.
 */
export const MODULE_PLATFORM_ALLOWED_PACKAGE_IMPORTS = [
  "@foundry/sandbox/container/constraints",
  "@foundry/sandbox/container/containers",
  "@foundry/sandbox/container/types",
] as const;

/** Filesystem access stays inside the separate Node entry. */
export const MODULE_NODE_ALLOWED_PACKAGE_IMPORTS = [
  "node:events",
  "node:crypto",
  "node:fs/promises",
  "node:path",
] as const;

export const MODULE_FORBIDDEN_VOCABULARY = [
  "ModuleKind",
  "QuickJS",
  "Realm",
  "HostBridge",
] as const;

const MODULE_SOURCE_ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * Whether `sourcePath` may import `specifier`. Relative specifiers resolve
 * against `sourcePath` and must stay inside `src`; without a source path they
 * cannot be resolved and are refused.
 */
export function isModuleAllowedImport(
  specifier: string,
  sourcePath = ""
): boolean {
  const normalizedPath = sourcePath.replaceAll("\\", "/");
  return (
    isInsideModuleSource(specifier, sourcePath) ||
    MODULE_ALLOWED_PACKAGE_IMPORTS.some(
      (allowed) => specifier === allowed || specifier.startsWith(`${allowed}/`)
    ) ||
    (normalizedPath.includes("/platform/") &&
      MODULE_PLATFORM_ALLOWED_PACKAGE_IMPORTS.some(
        (allowed) => specifier === allowed
      )) ||
    (normalizedPath.includes("/node/") &&
      MODULE_NODE_ALLOWED_PACKAGE_IMPORTS.some(
        (allowed) => specifier === allowed
      ))
  );
}

function isInsideModuleSource(specifier: string, sourcePath: string): boolean {
  if (
    sourcePath === "" ||
    !(specifier.startsWith("./") || specifier.startsWith("../"))
  ) {
    return false;
  }
  return resolve(dirname(sourcePath), specifier).startsWith(
    `${MODULE_SOURCE_ROOT}${sep}`
  );
}
