import type { StorageReader } from "@foundry/core/storage";

import { decodeUtf8 } from "@foundry/lib/encoding";

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
