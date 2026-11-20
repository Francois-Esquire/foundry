import type { Chart, Point } from "../../../data/chart";
import { turned } from "../world/town-parts";
import type { Building, WorldPlan } from "../world/world";

const FOOTPRINT_SLOP = 0.15;

export interface BuildingIndex {
  at: (island: number, at: Point) => Building | null;
  byId: (id: number) => Building | undefined;
  ofModule: (id: string) => Building | undefined;
}

function inside(building: Building, at: Point): number | null {
  const [x, z] = turned(
    [at[0] - building.at[0], at[1] - building.at[1]],
    -building.turn
  );
  const across = building.half[0] + FOOTPRINT_SLOP - Math.abs(x);
  const deep = building.half[1] + FOOTPRINT_SLOP - Math.abs(z);
  return across >= 0 && deep >= 0 ? Math.min(across, deep) : null;
}

export function buildingIndex(chart: Chart, world: WorldPlan): BuildingIndex {
  const byId = new Map<number, Building>();
  const byIsland = new Map<string, Building[]>();
  for (const building of world.buildings) {
    byId.set(building.id, building);
    const list = byIsland.get(building.island) ?? [];
    list.push(building);
    byIsland.set(building.island, list);
  }
  return {
    at(island, at) {
      const id = chart.islands[island]?.id;
      let best: Building | null = null;
      let depth = Number.NEGATIVE_INFINITY;
      for (const building of (id && byIsland.get(id)) || []) {
        const d = inside(building, at);
        if (d !== null && d > depth) {
          best = building;
          depth = d;
        }
      }
      return best;
    },
    byId: (id) => byId.get(id),
    ofModule: (id) => {
      const building = world.buildingOf.get(id);
      return building === undefined ? undefined : byId.get(building);
    },
  };
}
