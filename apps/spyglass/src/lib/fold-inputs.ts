import { ts } from "ts-morph";
import { join, relative } from "#path";
import type { RepositoryReader } from "./boundary-manifest";
import { resolveBoundary, workspacePatterns } from "./boundary-manifest";
import type { Boundary } from "./boundary-model";
import { toPosix } from "./boundary-model";
import type {
  FoldDestinationInput,
  FoldInputs,
  FoldRead,
  FoldSourceInput,
  ManifestSections,
} from "./fold-planning";
import { shortNameOf } from "./fold-planning";
import type { Ignorer } from "./ignore-rules";

// Fold planning's repository reads over a reader and gitignore answers.
// `fold-plan.ts` answers them natively; `file-map-preparation.ts` from a
// recorded file map. Manifests and tsconfig files are parsed as data.

/** The fold reads beyond the manifest rules': directory entries and config text. */
export interface FoldReader extends RepositoryReader {
  /** The entries directly below `dir`; links are not directories. */
  entries(dir: string): { directory: boolean; name: string }[];
  /** A tsconfig's text as the compiler reads it; undefined when absent. */
  readConfigText(file: string): string | undefined;
}

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
]);

function readOf<T>(read: () => T): FoldRead<T> {
  try {
    return { value: read() };
  } catch (error) {
    return { error };
  }
}

function walkFiles(
  reader: FoldReader,
  boundary: Boundary,
  ignorer: Ignorer
): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of reader.entries(dir)) {
      const abs = join(dir, entry.name);
      const rel = toPosix(relative(boundary.root, abs));
      if (entry.directory) {
        if (!(SKIP_DIRS.has(entry.name) || ignorer.ignores(`${rel}/`))) {
          walk(abs);
        }
      } else if (!ignorer.ignores(rel)) {
        files.push(rel);
      }
    }
  };
  walk(boundary.dir);
  return files.sort((a, b) => a.localeCompare(b));
}

function readDestination(
  reader: FoldReader,
  root: string,
  name: string,
  shortNames: readonly string[]
): FoldDestinationInput | null {
  let dest: Boundary | undefined;
  try {
    dest = resolveBoundary(reader, root, name);
  } catch {
    return null;
  }
  const { dir } = dest;
  const hasSrc = reader.exists(join(dir, "src"));
  const srcEntries = new Map<string, boolean>();
  if (hasSrc) {
    for (const shortName of shortNames) {
      srcEntries.set(shortName, reader.exists(join(dir, "src", shortName)));
    }
  }
  const manifestFile = join(dir, "package.json");
  const tsconfigFile = join(dir, "tsconfig.json");
  return {
    dir,
    hasSrc,
    ...(reader.exists(manifestFile) && {
      manifest: readOf(() => {
        const manifest = JSON.parse(
          reader.readFile(manifestFile)
        ) as ManifestSections;
        return {
          dependencies: manifest.dependencies,
          devDependencies: manifest.devDependencies,
          peerDependencies: manifest.peerDependencies,
        };
      }),
    }),
    relPath: dest.relPath,
    srcEntries,
    ...(reader.exists(tsconfigFile) && {
      tsconfig: { references: tsconfigReferences(reader, tsconfigFile) },
    }),
  };
}

/** tsconfig `references`, JSONC-safe; undefined when the file does not parse. */
function tsconfigReferences(reader: FoldReader, tsconfigFile: string): unknown {
  const parsed = ts.readConfigFile(tsconfigFile, (file) =>
    reader.readConfigText(file)
  );
  const config = parsed.config as { references?: unknown } | undefined;
  return config?.references;
}

/**
 * Read the fold planner's inputs through `reader`: each source package's
 * walk and configuration files, each destination name's boundary and its
 * manifest, tsconfig and `src` entries, and the root's workspace patterns.
 * Reads that throw are kept as errors for planning to raise.
 */
export function readFoldInputsWith(
  reader: FoldReader,
  ignorer: Ignorer,
  root: string,
  sources: readonly Boundary[],
  destinationNames: Iterable<string>
): FoldInputs {
  const ordered = [...sources].sort((a, b) => a.dir.localeCompare(b.dir));
  const sourceInputs = new Map<string, FoldSourceInput>();
  for (const boundary of ordered) {
    if (boundary.root !== root) {
      throw new Error(
        `Fold source ${boundary.dir} belongs to ${boundary.root}, not ${root}`
      );
    }
    sourceInputs.set(boundary.dir, {
      files: readOf(() => walkFiles(reader, boundary, ignorer)),
      hasManifest: reader.exists(join(boundary.dir, "package.json")),
      hasTsconfig: reader.exists(join(boundary.dir, "tsconfig.json")),
    });
  }
  const shortNames = [
    ...new Set(
      ordered.flatMap((boundary) => {
        const shortName = shortNameOf(boundary);
        return shortName === undefined ? [] : [shortName];
      })
    ),
  ].sort((a, b) => a.localeCompare(b));
  const destinations = new Map<string, FoldDestinationInput | null>();
  for (const name of [...new Set(destinationNames)].sort((a, b) =>
    a.localeCompare(b)
  )) {
    destinations.set(name, readDestination(reader, root, name, shortNames));
  }
  return {
    destinations,
    root,
    sources: sourceInputs,
    workspacePatterns: readOf(() => workspacePatterns(reader, root)),
  };
}
