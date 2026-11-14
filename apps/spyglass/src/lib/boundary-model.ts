import { dirname, isAbsolute, normalize, relative, sep } from "#path";

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

export const FIXTURE_DIR = "test/fixtures";

export interface Boundary {
  dir: string;

  explicitlyPublishable: boolean;

  exportSubpaths: Set<string> | null;
  packageName?: string;
  relPath: string;
  root: string;
  type: "package" | "directory";
}

export interface BoundaryEntrypoint {
  entrypoint: string;

  file: string;
}

export function boundaryContains(
  boundary: Boundary,
  filePath: string
): boolean {
  const rel = relative(boundary.dir, filePath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

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

export type SourceOwner = (filePath: string) => string;

export type OwnerResult =
  | { readonly owner: string }
  | { readonly ownerError: unknown };

export function ownerResult(
  ownerOf: SourceOwner,
  filePath: string
): OwnerResult {
  try {
    return { owner: ownerOf(filePath) };
  } catch (error) {
    return { ownerError: error };
  }
}

export const ROOT_OWNER = "<root>";

export type DirectoryVerdict =
  | { readonly owner: string }
  | { readonly error: string };

export interface DirectoryOwnership {
  readonly root: string;
  readonly unwalked: ReadonlySet<string>;

  readonly verdicts: ReadonlyMap<string, DirectoryVerdict>;
}

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
