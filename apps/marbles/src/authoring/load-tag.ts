/**
 * How a module of a workspace's load is named: a host imports each load's
 * modules as copies of their own (`workspace/copies.ts`), each the file's
 * path with the load's number in its query, and for a data file the
 * format it is read as. Which workspace a copy's code belongs to is not
 * read from here: its library words say so (`runtime.ts`, `inLoad`).
 */

const TAG = "?marbles-load=";
const COPY_TAG = /\?marbles-load=(\d+)(?:&format=(\w+))?$/;

let lastLoad = 0;

/** A load number no other load of this process has. */
export function newLoad(): number {
  lastLoad += 1;
  return lastLoad;
}

/** The copy of `file` that load `load` imports, read as `format` for a data file. */
export function copyPath(file: string, load: number, format?: string): string {
  const read = format === undefined ? "" : `&format=${format}`;
  return `${file}${TAG}${String(load)}${read}`;
}

/** `path` without a copy's query: the file as written. */
export function sourcePath(path: string): string {
  const start = path.indexOf(TAG);
  return start === -1 ? path : path.slice(0, start);
}

/** The load `path` is a copy of, and the format a data copy is read as; undefined for a module of no load. */
export function copyOf(
  path: string
): { readonly format?: string; readonly load: number } | undefined {
  const match = COPY_TAG.exec(path);
  if (match === null) {
    return;
  }
  const [, load = "", format] = match;
  return format === undefined
    ? { load: Number(load) }
    : { format, load: Number(load) };
}
