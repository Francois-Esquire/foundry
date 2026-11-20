const TAG = "?marbles-load=";
const COPY_TAG = /\?marbles-load=(\d+)(?:&format=(\w+))?$/;

let lastLoad = 0;

export function newLoad(): number {
  lastLoad += 1;
  return lastLoad;
}

export function copyPath(file: string, load: number, format?: string): string {
  const read = format === undefined ? "" : `&format=${format}`;
  return `${file}${TAG}${String(load)}${read}`;
}

export function sourcePath(path: string): string {
  const start = path.indexOf(TAG);
  return start === -1 ? path : path.slice(0, start);
}

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
