import type { Polygon, SpyglassData } from "../data/types";
import { landmassFootprint } from "./landmass-footprint";
import { packageGroups } from "./landmasses";

export type Continent = ReturnType<typeof createContinents>[number];

export function createContinents(data: SpyglassData, buffer: number) {
  return packageGroups(data.territories, data.routes, data.declaredDependencies)
    .filter((members) => members.length > 1)
    .map((members) => ({ field: landmassFootprint(members, buffer), members }));
}

export function continentCoasts(
  data: SpyglassData,
  continents: Continent[]
): Polygon[] {
  return [
    ...continents.flatMap((c) => c.field.outline.map((ring) => [ring])),
    ...data.territories.flatMap((p) =>
      p.coast.map((polygon) =>
        polygon.map((ring) =>
          ring.map(([x, y]): [number, number] => [p.x + x, p.y + y])
        )
      )
    ),
  ];
}

export function continentCell(continent: Continent, x: number, y: number) {
  const { field } = continent;
  const start = field.point(0);
  const col = Math.round((x - start.x) / field.step),
    row = Math.round((y - start.y) / field.step);
  return col < 0 || row < 0 || col >= field.width || row >= field.height
    ? -1
    : row * field.width + col;
}

export function continentHeight(continent: Continent, x: number, y: number) {
  const i = continentCell(continent, x, y),
    { field } = continent;
  const shore = Math.min(1, ((field.inland[i] ?? 0) * field.step) / 28);
  const clearing = Math.min(
    1,
    ((field.settlementDistance[i] ?? 0) * field.step) / 32
  );
  return (
    0.16 +
    shore * clearing * (1.3 + 0.45 * Math.sin(x / 85) * Math.cos(y / 110))
  );
}
