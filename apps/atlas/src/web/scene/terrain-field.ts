import {
  ridgeFoot,
  ridgeProfile,
  ridgeStretch,
  terrainNeighborhood,
  terrainProminence,
} from "../codex/bindings";
import type { AtlasFile, Territory } from "../types";

interface Crest {
  elevation: number;
  reach: number;
  stretch: number;
  ux: number;
  uy: number;
  x: number;
  y: number;
}

/** The local file distribution sets ridge orientation; no seeded terrain noise. */
function crest(file: AtlasFile, territory: Territory): Crest {
  let xx = 0;
  let xy = 0;
  let yy = 0;
  let mass = 0;
  for (const other of territory.files) {
    const dx = other.x - file.x;
    const dy = other.y - file.y;
    const weight = terrainNeighborhood(Math.hypot(dx, dy));
    xx += dx * dx * weight;
    xy += dx * dy * weight;
    yy += dy * dy * weight;
    mass += weight;
  }
  const angle = Math.atan2(2 * xy, xx - yy) / 2;
  const spread = Math.hypot(xx - yy, 2 * xy);
  const stretch = ridgeStretch(spread, xx + yy);
  return {
    ...ridgeFoot(
      terrainProminence(mass, file.incoming),
      coastDistance(territory, file.x, file.y),
      stretch
    ),
    stretch,
    ux: Math.cos(angle),
    uy: Math.sin(angle),
    x: file.x,
    y: file.y,
  };
}

// An acceleration grid, independent of the visual profile and mesh resolution.
const crestCellSize = 16;

function crestSampler(crests: Crest[]) {
  const bins = new Map<string, Crest[]>();
  for (const ridge of crests) {
    const radius = ridge.reach * ridge.stretch;
    const left = Math.floor((ridge.x - radius) / crestCellSize);
    const right = Math.floor((ridge.x + radius) / crestCellSize);
    const top = Math.floor((ridge.y - radius) / crestCellSize);
    const bottom = Math.floor((ridge.y + radius) / crestCellSize);
    for (let row = top; row <= bottom; row += 1) {
      for (let col = left; col <= right; col += 1) {
        const key = `${col}:${row}`;
        const bin = bins.get(key) ?? [];
        bin.push(ridge);
        bins.set(key, bin);
      }
    }
  }
  return (x: number, y: number) => {
    let elevation = 0;
    const key = `${Math.floor(x / crestCellSize)}:${Math.floor(y / crestCellSize)}`;
    for (const ridge of bins.get(key) ?? []) {
      const dx = x - ridge.x;
      const dy = y - ridge.y;
      const along = (dx * ridge.ux + dy * ridge.uy) / ridge.stretch;
      const across = -dx * ridge.uy + dy * ridge.ux;
      if (along * along + across * across >= ridge.reach * ridge.reach) {
        continue;
      }
      elevation = Math.max(
        elevation,
        ridgeProfile(Math.hypot(along, across), ridge.reach, ridge.elevation)
      );
    }
    return elevation;
  };
}

function coastDistance(territory: Territory, x: number, y: number) {
  let distance = Number.POSITIVE_INFINITY;
  for (const polygon of territory.coast) {
    for (const ring of polygon) {
      for (let i = 1; i < ring.length; i += 1) {
        const a = ring[i - 1];
        const b = ring[i];
        if (!(a && b)) {
          continue;
        }
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const t = Math.max(
          0,
          Math.min(
            1,
            ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)
          )
        );
        distance = Math.min(
          distance,
          Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy)
        );
      }
    }
  }
  return distance;
}

export function createTerrainField(territory: Territory) {
  const ridgeHeight = crestSampler(
    territory.files.map((file) => crest(file, territory))
  );
  return {
    sample: (x: number, y: number) => ({ elevation: ridgeHeight(x, y) }),
  };
}

export type TerrainField = ReturnType<typeof createTerrainField>;

const fields = new WeakMap<Territory, TerrainField>();

export function baseTerrainField(territory: Territory) {
  let field = fields.get(territory);
  if (!field) {
    field = createTerrainField(territory);
    fields.set(territory, field);
  }
  return field;
}
