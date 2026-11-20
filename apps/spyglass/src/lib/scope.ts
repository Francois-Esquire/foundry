import { resolve } from "node:path";
import type { Node, Project } from "ts-morph";

import type { Boundary } from "./boundary";

import { boundaryEntrypoints } from "./boundary";

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
