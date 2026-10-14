import { resolve } from "node:path";
import type { Node, Project } from "ts-morph";

import type { Boundary } from "./boundary";

import { boundaryEntrypoints } from "./boundary";

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
 * behavior; plan-level package blockers still apply).
 */
export function packagePublicNodes(
  project: Project,
  boundary: Boundary
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
  const entries = boundaryEntrypoints(boundary);
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
