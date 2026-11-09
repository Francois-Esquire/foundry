import type { SpyglassFile, Territory } from "../data/types";

/**
 * Where the map draws a file, by its id, in chart coordinates: the renderer
 * moves each file into a building of its town (Islands' `moduleAt`). Null
 * when the map has no place for it.
 */
export type FileAt = (fileId: string) => readonly [number, number] | null;

/** Where a file stands on the chart: where the map draws it, else its place on its island. */
export function filePlace(
  territory: Territory,
  file: SpyglassFile,
  fileAt?: FileAt
): { x: number; y: number } {
  const drawn = fileAt ? fileAt(file.id) : null;
  if (drawn === null) {
    return { x: territory.x + file.x, y: territory.y + file.y };
  }
  return { x: drawn[0], y: drawn[1] };
}
