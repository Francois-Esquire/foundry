import type { SpyglassFile, Territory } from "../data/types";

export type FileAt = (fileId: string) => readonly [number, number] | null;

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
