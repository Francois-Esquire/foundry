import type { StorageReader } from "@foundry/core/storage";

import { decodeUtf8 } from "@foundry/lib/encoding";
import { isPortableRelativePath } from "./manifest";
import { MODULE_SETTING_HOST_POLICY } from "./settings";

/**
 * The most Module source a host admits, whichever path it enters through
 * (a save, disk synchronization, or a proposal). Each limit names its unit;
 * these are the `authoring.source.*` settings' host ceilings, and a
 * Module's effective settings may lower them.
 */
export const MODULE_SOURCE_LIMITS = Object.freeze({
  /** All files together, in UTF-8 bytes. */
  maxBytes: MODULE_SETTING_HOST_POLICY["authoring.source.maxBytes"].ceiling,
  /** One text file, in UTF-16 code units (a JavaScript string's length). */
  maxFileCodeUnits:
    MODULE_SETTING_HOST_POLICY["authoring.source.maxFileCodeUnits"].ceiling,
  maxFiles: MODULE_SETTING_HOST_POLICY["authoring.source.maxFiles"].ceiling,
  /** One path, in UTF-16 code units. */
  maxPathCharacters:
    MODULE_SETTING_HOST_POLICY["authoring.source.maxPathCharacters"].ceiling,
} as const);

export type ModuleSourceLimits = {
  readonly [Limit in keyof typeof MODULE_SOURCE_LIMITS]: number;
};

export class ModuleSourceAdmissionError extends Error {
  override readonly name = "ModuleSourceAdmissionError";
}

const encoder = new TextEncoder();

/** Why `source` cannot be admitted, or `null` when it can. */
export function moduleSourceAdmissionProblem(
  source: Readonly<Record<string, string>>,
  limits: ModuleSourceLimits = MODULE_SOURCE_LIMITS
): string | null {
  const entries = Object.entries(source);
  if (entries.length > limits.maxFiles) {
    return `Source has ${entries.length} files; the limit is ${limits.maxFiles}.`;
  }
  let bytes = 0;
  for (const [path, text] of entries) {
    if (path.length > limits.maxPathCharacters) {
      return `A source path is longer than ${limits.maxPathCharacters} characters.`;
    }
    if (!isPortableRelativePath(path)) {
      return `Source path is not a portable relative path: ${path}`;
    }
    if (text.length > limits.maxFileCodeUnits) {
      return `${path} is longer than ${limits.maxFileCodeUnits} UTF-16 code units.`;
    }
    bytes += encoder.encode(text).byteLength;
    if (bytes > limits.maxBytes) {
      return `Source is larger than ${limits.maxBytes} UTF-8 bytes.`;
    }
  }
  return null;
}

/** Throws a {@link ModuleSourceAdmissionError} unless `source` is admissible. */
export function admitModuleSource(
  source: Readonly<Record<string, string>>,
  limits: ModuleSourceLimits = MODULE_SOURCE_LIMITS
): void {
  const problem = moduleSourceAdmissionProblem(source, limits);
  if (problem !== null) {
    throw new ModuleSourceAdmissionError(problem);
  }
}

export type ModuleSourceFileSystem = Pick<
  StorageReader,
  "readDirectory" | "readFile" | "separator"
>;

export async function captureModuleWorkspaceSource(
  filesystem: ModuleSourceFileSystem,
  root: string
): Promise<Readonly<Record<string, string>>> {
  const source = new Map<string, string>();
  const pending = [{ absolute: root, relative: "" }];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) {
      continue;
    }
    for (const entry of await filesystem.readDirectory(directory.absolute)) {
      const relative = relativeChildPath(directory.relative, entry.name);
      if (isDerivedSourcePath(relative)) {
        continue;
      }
      const absolute = absoluteChildPath(
        directory.absolute,
        entry.name,
        filesystem.separator
      );
      if (entry.type === "directory") {
        pending.push({ absolute, relative });
      } else if (entry.type === "file") {
        const text = decodeUtf8(await filesystem.readFile(absolute));
        if (text === null) {
          throw new TypeError(`Module source ${relative} is not UTF-8`);
        }
        source.set(relative, text);
      } else {
        throw new Error(
          `Module source contains unsupported ${entry.type}: ${relative}`
        );
      }
    }
  }
  return Object.freeze(Object.fromEntries(source));
}

function relativeChildPath(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

function absoluteChildPath(
  parent: string,
  name: string,
  separator: string
): string {
  return parent.endsWith(separator) ? parent + name : parent + separator + name;
}

const DERIVED_DATABASE_PATH = /\.sqlite(?:-(?:wal|shm))?$/u;

function isDerivedSourcePath(path: string): boolean {
  return (
    DERIVED_DATABASE_PATH.test(path) ||
    path.split("/").some((segment, index, segments) => {
      if (
        segment === "dist" &&
        index === 2 &&
        segments[0] === "packages" &&
        segments[1] === "module-sdk"
      ) {
        return false;
      }
      return DERIVED_DIRS.has(segment) || segment.startsWith(".env");
    })
  );
}

const DERIVED_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".turbo",
  ".cache",
  ".tmp",
  ".data",
  "generated",
  ".ssh",
  ".aws",
  ".npmrc",
  ".netrc",
]);
