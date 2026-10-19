import type { SpyglassData, SpyglassFile, Territory } from "../data/types";
import { insidePolygons } from "./polygons";
import { drapedHeight, type ReliefOf } from "./terrain-height";

/** Architectural silhouettes retain the exact positions of their source files. */
export interface Building {
  base: number;
  file: SpyglassFile;
  footing: number;
  height: number;
  /** Recorded use by another package, not an inference about a public API. */
  landmark: boolean;
  territory: Territory;
  width: number;
  x: number;
  y: number;
}

const maximumWidth = 5;
const minimumWidth = 0.6;
const neighborCell = maximumWidth * 2;

/** Height encodes incoming module imports, with a bounded logarithmic scale. */
export function buildingHeight(incoming: number): number {
  return 3 + Math.min(12, Math.log2(1 + Math.max(0, incoming)) * 2);
}

/** The visible roof ridge or pyramid tip, shared by the mesh and its label. */
export function buildingTop(building: Building, presentation: number): number {
  const height =
    building.height + 0.22 + building.width * (building.landmark ? 0.8 : 0.38);
  return building.base + building.footing + height * presentation;
}

function coastClearance(territory: Territory, file: SpyglassFile): number {
  let distance = Number.POSITIVE_INFINITY;
  for (const polygon of territory.coast) {
    for (const ring of polygon) {
      for (let index = 0; index < ring.length; index += 1) {
        const a = ring[index];
        const b = ring[(index + 1) % ring.length];
        if (!(a && b)) {
          continue;
        }
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const fraction = Math.max(
          0,
          Math.min(
            1,
            ((file.x - a[0]) * dx + (file.y - a[1]) * dy) /
              (dx * dx + dy * dy || 1)
          )
        );
        distance = Math.min(
          distance,
          Math.hypot(
            file.x - a[0] - fraction * dx,
            file.y - a[1] - fraction * dy
          )
        );
      }
    }
  }
  return distance;
}

/** Local buckets bound spacing work on large packages; the layout never moves files. */
function neighborDistances(files: readonly SpyglassFile[]) {
  const buckets = new Map<string, SpyglassFile[]>();
  for (const file of files) {
    const key = `${Math.floor(file.x / neighborCell)},${Math.floor(file.y / neighborCell)}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(file);
    buckets.set(key, bucket);
  }
  return (file: SpyglassFile) => {
    let distance = neighborCell;
    const cellX = Math.floor(file.x / neighborCell);
    const cellY = Math.floor(file.y / neighborCell);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const neighbor of buckets.get(`${cellX + dx},${cellY + dy}`) ??
          []) {
          if (neighbor === file) {
            continue;
          }
          distance = Math.min(
            distance,
            Math.hypot(file.x - neighbor.x, file.y - neighbor.y)
          );
          // Once no viable footprint fits, denser buckets need no more work.
          if (distance < minimumWidth / 0.6) {
            return distance;
          }
        }
      }
    }
    return distance;
  };
}

function placeBuilding(
  territory: Territory,
  file: SpyglassFile,
  relief: Territory,
  neighborDistance: number,
  landmark: boolean
): Building | null {
  if (!insidePolygons(file, territory.coast)) {
    return null;
  }
  // The circle around the widest roof remains inside the coast and clear
  // of its neighbors, including concave shores and holes in the land.
  const width = Math.min(
    maximumWidth,
    coastClearance(territory, file) * 1.2,
    neighborDistance * 0.6
  );
  if (width < minimumWidth) {
    return null;
  }
  const x = territory.x + file.x;
  const y = territory.y + file.y;
  const elevations = [drapedHeight(relief, x, y)];
  for (const dx of [-width / 2, width / 2]) {
    for (const dy of [-width / 2, width / 2]) {
      elevations.push(drapedHeight(relief, x + dx, y + dy));
    }
  }
  const base = Math.min(...elevations);
  return {
    base,
    file,
    footing: Math.max(...elevations) - base,
    height: buildingHeight(file.incoming),
    landmark,
    territory,
    width,
    x,
    y,
  };
}

/**
 * Every file with room for a footprint gets one building. Tight clusters
 * and shore-edge files keep their existing map marks rather than moving
 * or merging their identities. No top-N sampling changes a package's skyline.
 */
export function layoutBuildings(
  data: Pick<SpyglassData, "territories" | "routes">,
  reliefOf: ReliefOf = (territory) => territory
): Building[] {
  const externallyUsed = new Set(
    data.routes.flatMap((route) => route.supplierFiles)
  );
  const buildings: Building[] = [];
  for (const territory of data.territories) {
    const nearest = neighborDistances(territory.files);
    const relief = reliefOf(territory);
    for (const file of territory.files) {
      const building = placeBuilding(
        territory,
        file,
        relief,
        nearest(file),
        externallyUsed.has(file.id)
      );
      if (building) {
        buildings.push(building);
      }
    }
  }
  return buildings;
}

/** Subpixel buildings stay represented by file marks until they become legible. */
export function buildingVisible(
  building: Pick<Building, "width">,
  pixelsPerUnit: number
): boolean {
  return building.width * pixelsPerUnit >= 2;
}
