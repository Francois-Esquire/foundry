import type { Node, Project } from "ts-morph";
import { resolve } from "#path";
import type { Boundary, BoundaryEntrypoint } from "./boundary-model";

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
