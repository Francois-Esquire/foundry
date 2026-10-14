import type { Shape } from "@s/b";

import { area } from "@s/b";

export interface Tile extends Shape {
  label: string;
}

export function describe(tile: Tile): string {
  return `${tile.label}: ${String(area(tile))}`;
}
