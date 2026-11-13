import { dirname, isAbsolute, normalize, relative, sep } from "#path";

// Boundary values and the lookups that read nothing: what a boundary is,
// whether it contains a path, how a specifier reaches it, and owner answers
// from prepared directory verdicts. `boundary.ts` reads manifests and
// directories to produce these values; prepared analysis imports only this
// module.

/** Generated and vendored directories no analysis looks inside. */
export const EXCLUDED_DIRS = [
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "storybook-static",
];

/**
 * Test fixtures below an analyzed root are inputs to that package's tests,
 * not part of its semantic surface: their manifests would otherwise register
 * phantom workspace packages. Matched relative to the root, so analyzing a
 * fixture directory itself is unaffected.
 */
export const FIXTURE_DIR = "test/fixtures";

export interface Boundary {
  dir: string;
  /** True when package.json declares `"private": false`. */
  explicitlyPublishable: boolean;
  /**
   * Subpaths declared in package.json "exports" ("" = root entry).
   * null means no exports field: only the bare package name counts as public.
   */
  exportSubpaths: Set<string> | null;
  packageName?: string;
  relPath: string;
  root: string;
  type: "package" | "directory";
}

export interface BoundaryEntrypoint {
  /** Import specifier for this entry (package name, or name/subpath). */
  entrypoint: string;
  /** Root-relative posix path of the resolved TypeScript source. */
  file: string;
}

export function boundaryContains(
  boundary: Boundary,
  filePath: string
): boolean {
  const rel = relative(boundary.dir, filePath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Classify an import module specifier reaching into the boundary.
 * Returns "public" when it goes through the package name and a declared
 * exports subpath (or the bare name), "deep" otherwise (relative paths,
 * aliases, undeclared subpaths).
 */
export function classifySpecifier(
  boundary: Boundary,
  specifier: string
): "public" | "deep" {
  const name = boundary.packageName;
  if (!name) {
    return "deep";
  }
  if (specifier === name) {
    return "public";
  }
  if (specifier.startsWith(`${name}/`)) {
    const subpath = specifier.slice(name.length + 1);
    const declared = boundary.exportSubpaths;
    if (declared === null) {
      return "deep";
    }
    if (declared.has(subpath)) {
      return "public";
    }
    for (const entry of declared) {
      if (!entry.includes("*")) {
        continue;
      }
      const [prefix, suffix] = entry.split("*");
      if (subpath.startsWith(prefix ?? "") && subpath.endsWith(suffix ?? "")) {
        return "public";
      }
    }
    return "deep";
  }
  return "deep";
}

/** The workspace boundary name owning an absolute source path. */
export type SourceOwner = (filePath: string) => string;

/** The owner a file gets when no workspace boundary encloses it. */
export const ROOT_OWNER = "<root>";

/**
 * What `ownerBoundary` concludes at a directory where its walk stops: the
 * boundary it names, or the message of the manifest read error it throws.
 * Its walk continues upward from every other directory.
 */
export type DirectoryVerdict =
  | { readonly owner: string }
  | { readonly error: string };

/**
 * `ownerBoundary`'s verdicts below `root`, read once so that any later path
 * below them can be owned without the file system. The walk does not enter
 * `node_modules` or `.git` directories, follow symbolic links or read
 * unreadable directories; those are `unwalked`, and a lookup through one
 * fails. A directory absent at preparation holds no manifest then, so the
 * native walk continued past it.
 */
export interface DirectoryOwnership {
  /** The real, absolute root `ownerBoundary` is called with. */
  readonly root: string;
  readonly unwalked: ReadonlySet<string>;
  /** Every walked directory strictly below the root where the walk stops. */
  readonly verdicts: ReadonlyMap<string, DirectoryVerdict>;
}

/**
 * `ownerBoundary(snapshot.root, filePath)` answered from the snapshot alone,
 * as of preparation. Exact for a normalized absolute path that reaches no
 * unwalked directory, which holds for real paths below the root outside
 * `node_modules` and `.git`. TypeScript realpaths only `node_modules`
 * resolutions, so a relative or `paths` import through an in-root symbolic
 * link keeps the link's spelling; callers table such files' owners natively
 * and use this only for paths they did not. A path outside the root is `<root>`, as
 * natively. A path through an unwalked directory, or below a sibling whose
 * name only starts with the root's (where the native string-prefix walk
 * would read that sibling's manifests), throws instead of guessing; so does
 * reaching a directory whose manifest the native walk could not parse.
 */
export function ownerFromDirectories(
  snapshot: DirectoryOwnership,
  filePath: string
): string {
  if (!isAbsolute(filePath) || normalize(filePath) !== filePath) {
    throw new Error(`Cannot own a non-normalized path: ${filePath}`);
  }
  const { root, unwalked, verdicts } = snapshot;
  let dir = dirname(filePath);
  if (!dir.startsWith(root) || dir === root) {
    return ROOT_OWNER;
  }
  if (!dir.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
    throw new Error(
      `${filePath} is outside ${root} but shares its prefix; its owner was not prepared`
    );
  }
  while (dir !== root) {
    if (unwalked.has(dir)) {
      throw new Error(
        `No prepared directory ownership for ${filePath}: ${dir} was not walked`
      );
    }
    const verdict = verdicts.get(dir);
    if (verdict !== undefined) {
      if ("error" in verdict) {
        throw new Error(verdict.error);
      }
      return verdict.owner;
    }
    dir = dirname(dir);
  }
  return ROOT_OWNER;
}

export function toPosix(value: string): string {
  return value.split(sep).join("/");
}
