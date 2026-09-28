import { insidePolygons } from "./atmosphere";
import { settlementTier } from "./codex/bindings";
import { territoryLabelY, unit } from "./geography";
import { landmassFootprint } from "./landmass-footprint";
import { packageGroups } from "./landmasses";
import type { AtlasData, Polygon, Territory } from "./types";

export type Continent = ReturnType<typeof createContinents>[number];

export function createContinents(data: AtlasData, buffer: number) {
  return packageGroups(data.territories, data.routes, data.declaredDependencies)
    .filter((members) => members.length > 1)
    .map((members) => ({ field: landmassFootprint(members, buffer), members }));
}

export function continentCoasts(
  data: AtlasData,
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

export function settlementBuildings(p: Territory) {
  const kind = settlementTier(p.files.length);
  const target = kind === "city" ? 64 : kind === "town" ? 18 : 5;
  const points = p.coast.flat(2);
  if (!points.length) {
    return [];
  }
  const candidates: {
    x: number;
    y: number;
    size: number;
    height: number;
    angle: number;
  }[] = [];
  const left = Math.min(...points.map(([x]) => x)),
    right = Math.max(...points.map(([x]) => x));
  const top = Math.min(...points.map(([, y]) => y)),
    bottom = Math.max(...points.map(([, y]) => y));
  const step = kind === "village" ? 7 : 10;
  for (let y = top + 5; y < bottom - 5; y += step) {
    for (let x = left + 5; x < right - 5; x += step) {
      const seed = `${p.id}:${x}:${y}`;
      const size = (kind === "village" ? 3.2 : 4.6) + unit(seed) * 1.8;
      const xx = x + (unit(seed + "x") - 0.5) * 1.5,
        yy = y + (unit(seed + "y") - 0.5) * 1.5;
      if (
        ![-1, 1].every((dx) =>
          [-1, 1].every((dy) =>
            insidePolygons({ x: xx + dx * size, y: yy + dy * size }, p.coast)
          )
        )
      ) {
        continue;
      }
      candidates.push({
        angle: unit(p.id) > 0.5 ? 0 : Math.PI / 2,
        height: 2.5 + unit(seed + "height") * (kind === "city" ? 6 : 3),
        size,
        x: xx,
        y: yy,
      });
    }
  }
  candidates.sort(
    (a, b) =>
      Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y) || a.y - b.y || a.x - b.x
  );
  const placed: typeof candidates = [];
  for (const site of candidates) {
    if (
      placed.every((other) => {
        const width =
          (site.size + other.size) * (site.angle ? 0.725 : 0.6) + 0.8;
        const depth =
          (site.size + other.size) * (site.angle ? 0.6 : 0.725) + 0.8;
        return (
          Math.abs(site.x - other.x) >= width ||
          Math.abs(site.y - other.y) >= depth
        );
      })
    ) {
      placed.push(site);
    }
    if (placed.length === target) {
      break;
    }
  }
  return placed;
}

export function forestSites(continent: Continent) {
  const { field } = continent;
  const sites: { x: number; y: number; size: number }[] = [];
  const stride = 4;
  for (let row = 0; row < field.height; row += stride) {
    for (let col = 0; col < field.width; col += stride) {
      const point = field.point(row * field.width + col);
      const seed = `${continent.members[0]?.id}:${col}:${row}`;
      const x = point.x + (unit(seed) - 0.5) * 18,
        y = point.y + (unit(seed + "y") - 0.5) * 18;
      const i = continentCell(continent, x, y);
      if (
        !field.filled[i] ||
        (field.inland[i] ?? 0) * field.step < 14 ||
        (field.settlementDistance[i] ?? 0) * field.step < 20
      ) {
        continue;
      }
      const grove =
        Math.sin(x / 62 + Math.cos(y / 97)) + Math.cos(y / 73 - x / 125);
      if (grove + unit(seed + "grove") < 0.3) {
        continue;
      }
      const size = 6 + unit(seed + "size") * 4;
      if (
        continent.members.some(
          (p) =>
            Math.abs(x - p.x) < p.label.length * 4 + size &&
            Math.abs(y - p.y - territoryLabelY(p)) < 12 + size
        )
      ) {
        continue;
      }
      sites.push({ size, x, y });
    }
  }
  return sites;
}
