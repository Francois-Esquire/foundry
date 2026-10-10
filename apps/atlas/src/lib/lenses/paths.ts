// Browser-safe path arithmetic over workspace-relative folder ids, shared
// by the lenses that name folders, so that every lens names a folder alike.

/** The workspace root, as a folder id. */
export const WORKSPACE_ROOT = ".";

/** The folder holding a file or folder; the workspace root for a top-level one. */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? WORKSPACE_ROOT : path.slice(0, slash);
}

function segments(folder: string): string[] {
  return folder === WORKSPACE_ROOT ? [] : folder.split("/");
}

/**
 * Steps through the folder tree from one folder to another, up to their
 * deepest common folder and down again: 0 for the same folder, 1 for a
 * parent and child, 2 for siblings. A copy of the internal topology's own
 * measure (`InternalModuleEdge.distance`), which stays private to the
 * analysis; over folders of one package it gives the same number, since a
 * shared package root adds the same segments to both sides.
 */
export function directoryDistance(a: string, b: string): number {
  const left = segments(a);
  const right = segments(b);
  let common = 0;
  while (
    common < left.length &&
    common < right.length &&
    left[common] === right[common]
  ) {
    common += 1;
  }
  return left.length + right.length - 2 * common;
}
