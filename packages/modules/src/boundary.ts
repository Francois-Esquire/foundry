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
  "@foundry/lib/abort",
  "@foundry/lib/digest",
  "@foundry/lib/encoding",
  "@foundry/lib/json",
  "@foundry/lib/network",
  "@foundry/lib/ordering",
  "@foundry/lib/pagination",
  "@foundry/lib/turns",
  "zod",
] as const;

export const MODULE_PLATFORM_ALLOWED_PACKAGE_IMPORTS = [
  "@foundry/sandbox/container/constraints",
  "@foundry/sandbox/container/containers",
  "@foundry/sandbox/container/types",
] as const;

export const MODULE_SQLITE_ALLOWED_PACKAGE_IMPORTS = [
  "@foundry/lib/sqlite",
  "drizzle-orm",
  "drizzle-orm/sqlite-core",
] as const;

const MODULE_SQLITE_SOURCES = ["/store/sqlite.ts", "/store/tables.ts"] as const;

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
    (MODULE_SQLITE_SOURCES.some((source) => normalizedPath.endsWith(source)) &&
      MODULE_SQLITE_ALLOWED_PACKAGE_IMPORTS.some(
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
