export function joinPath(
  base: string,
  segment: string,
  separator = "/"
): string {
  if (base === "") {
    return segment;
  }
  return `${base.endsWith(separator) ? base : `${base}${separator}`}${segment}`;
}

export function isBeneath(
  root: string,
  candidate: string,
  separator: string
): boolean {
  return (
    candidate === root ||
    candidate.startsWith(
      root.endsWith(separator) ? root : `${root}${separator}`
    )
  );
}
