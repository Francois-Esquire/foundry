import type { Node, Project } from "ts-morph";
import { resolve } from "#path";
import type { Boundary, BoundaryEntrypoint } from "./boundary-model";

// Export scope: a module export is not automatically package API. A symbol is
// package-public only when some declared entrypoint (root or subpath) exposes
// it, following re-export chains; otherwise it exists only for internal
// module composition. This is the one source of truth for that distinction —
// downstream consumers read SurfaceSymbol.packagePublic instead of rederiving.

/**
 * Declaration nodes reachable from the declared package entrypoints. Returns
 * null when the public surface cannot be enumerated — directory boundary,
 * wildcard exports subpaths, no resolvable entrypoints, or an entrypoint
 * missing from the analyzed project — in which case callers must fall back to
 * treating every module export as potentially package-public (the pre-scope
 * behavior; plan-level package blockers still apply). Callers pass the
 * manifest's entrypoints they hold, so no manifest is reread.
 */
export function packagePublicNodes(
  project: Project,
  boundary: Boundary,
  entries: readonly BoundaryEntrypoint[]
): Set<Node> | null {
  if (boundary.type !== "package") {
    return null;
  }
  if (
    boundary.exportSubpaths !== null &&
    [...boundary.exportSubpaths].some((subpath) => subpath.includes("*"))
  ) {
    return null;
  }
  if (entries.length === 0) {
    return null;
  }
  const nodes = new Set<Node>();
  for (const entry of entries) {
    const file = project.getSourceFile(resolve(boundary.root, entry.file));
    if (file === undefined) {
      return null;
    }
    for (const declarations of file.getExportedDeclarations().values()) {
      for (const declaration of declarations) {
        nodes.add(declaration);
      }
    }
  }
  return nodes;
}
