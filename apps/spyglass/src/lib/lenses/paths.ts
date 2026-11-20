export const WORKSPACE_ROOT = ".";

export function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? WORKSPACE_ROOT : path.slice(0, slash);
}

function segments(folder: string): string[] {
  return folder === WORKSPACE_ROOT ? [] : folder.split("/");
}

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
