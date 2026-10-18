import type { SpyglassData, SpyglassFile, Territory } from "../data/types";

/** The files one file imports and is imported by, each once, with the island each sits on. */
export function fileConnections(data: SpyglassData, id: string) {
  const destinations = new Map<
    string,
    { territory: Territory; file: SpyglassFile }
  >();
  for (const territory of data.territories) {
    for (const file of territory.files) {
      destinations.set(file.id, { file, territory });
    }
  }
  const seen = new Set<string>();
  return data.fileEdges
    .flatMap((edge) => {
      let direction: "Imports" | "Imported by" | null;
      if (edge.source === id) {
        direction = "Imports";
      } else if (edge.target === id) {
        direction = "Imported by";
      } else {
        direction = null;
      }
      if (!direction) {
        return [];
      }
      const other = edge.source === id ? edge.target : edge.source;
      const destination = destinations.get(other);
      const key = `${direction}:${other}`;
      if (!destination || seen.has(key)) {
        return [];
      }
      seen.add(key);
      return [{ ...destination, direction }];
    })
    .sort(
      (a, b) =>
        a.direction.localeCompare(b.direction) ||
        a.file.path.localeCompare(b.file.path)
    );
}
