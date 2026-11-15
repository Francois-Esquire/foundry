/**
 * How a module of a workspace's load is named: a host imports each load's
 * modules as copies of their own (`workspace/copies.ts`), each the file's
 * path with the load's number in its query. Which workspace a copy's code
 * belongs to is not read from here: its library words say so
 * (`runtime.ts`, `inLoad`).
 */

const TAG = "?marbles-load=";
const COPY_TAG = /\?marbles-load=(\d+)$/;

let lastLoad = 0;

/** A load number no other load of this process has. */
export function newLoad(): number {
  lastLoad += 1;
  return lastLoad;
}

/** The copy of `file` that load `load` imports. */
export function copyPath(file: string, load: number): string {
  return `${file}${TAG}${String(load)}`;
}

/** `path` without a copy's query: the file as written. */
export function sourcePath(path: string): string {
  const start = path.indexOf(TAG);
  return start === -1 ? path : path.slice(0, start);
}

/** The load `path` is a copy of; undefined for a module of no load. */
export function loadOfPath(path: string): number | undefined {
  const match = COPY_TAG.exec(path);
  return match === null ? undefined : Number(match[1]);
}
