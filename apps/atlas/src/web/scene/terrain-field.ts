import {
  craterBowl,
  craterRelief,
  ridgeFoot,
  ridgeProfile,
  ridgeStretch,
  terrainNeighborhood,
  terrainProminence,
} from "../codex/bindings";
import type { Landmark } from "../landmarks";
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
function crest(
  file: AtlasFile,
  territory: Territory,
  structural: boolean
): Crest {
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
      terrainProminence(mass, file.incoming, structural),
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

function ridgeHeight(crests: Crest[], x: number, y: number) {
  let elevation = 0;
  for (const ridge of crests) {
    const dx = x - ridge.x;
    const dy = y - ridge.y;
    const along = (dx * ridge.ux + dy * ridge.uy) / ridge.stretch;
    const across = -dx * ridge.uy + dy * ridge.ux;
    elevation = Math.max(
      elevation,
      ridgeProfile(Math.hypot(along, across), ridge.reach, ridge.elevation)
    );
  }
  return elevation;
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

export function createTerrainField(
  territory: Territory,
  landmarks: readonly Landmark[] = []
) {
  const roles = new Set(
    landmarks
      .filter((item) => item.role !== "change")
      .map((item) => item.file.id)
  );
  const crests = territory.files.map((file) =>
    crest(file, territory, roles.has(file.id))
  );
  const craters = landmarks.flatMap((item) => {
    if (!item.change) {
      return [];
    }
    const { x, y } = item.file;
    const { radius, depth } = craterRelief(item.change.file.commits);
    return [
      {
        floor: Math.max(0.12, ridgeHeight(crests, x, y) - depth),
        radius,
        x,
        y,
      },
    ];
  });
  return {
    sample(x: number, y: number) {
      let elevation = ridgeHeight(crests, x, y);
      let mineral = 0;
      for (const crater of craters) {
        const q = Math.hypot(x - crater.x, y - crater.y) / crater.radius;
        if (q >= 1) {
          continue;
        }
        const bowl = craterBowl(crater.floor, q, elevation);
        if (bowl.elevation < elevation) {
          ({ elevation } = bowl);
          mineral = Math.max(mineral, bowl.mineral);
        }
      }
      return { elevation, mineral };
    },
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
