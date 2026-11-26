import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export interface PackageManifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly exports?: Record<string, unknown>;
  readonly name?: string;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

export function readManifest(packageDir: string): PackageManifest {
  return JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8")
  ) as PackageManifest;
}

export function resolveExportTarget(target: unknown): string | undefined {
  if (typeof target === "string") {
    return target;
  }
  if (typeof target === "object" && target !== null) {
    const record = target as Record<string, unknown>;
    return (
      resolveExportTarget(record.default) ?? resolveExportTarget(record.import)
    );
  }
  return undefined;
}

export function packageDirectories(packagesDir: string): string[] {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => join(packagesDir, entry.name));
}
