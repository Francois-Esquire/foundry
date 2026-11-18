export function covers(facet: string, place: string): boolean {
  if (facet.includes("#")) {
    return facet === place;
  }
  const [path = place] = place.split("#");
  return path === facet || path.startsWith(`${facet}/`);
}
