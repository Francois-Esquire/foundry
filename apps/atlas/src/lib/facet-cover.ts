// Kept apart from facet.ts, which validates facets with zod, so that the
// viewer can match a place against a facet without bundling the schema.

/**
 * Whether a facet covers a place: a symbol facet only the symbol it names, a
 * path facet everything at or below its path, by whole segments, so
 * `packages/co` does not cover `packages/core`. `#` ends the path, so a file
 * facet covers the file's symbols. Coverage runs downward only: a package is
 * not covered by a facet inside it.
 */
export function covers(facet: string, place: string): boolean {
  if (facet.includes("#")) {
    return facet === place;
  }
  const [path = place] = place.split("#");
  return path === facet || path.startsWith(`${facet}/`);
}
