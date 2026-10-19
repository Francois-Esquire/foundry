import { shoreDistances } from "../../lib/visualization/distance-field";
import {
  geologyLevels,
  type Landform,
  sampleGrid,
} from "../../lib/visualization/geology";
import { fillPolygon } from "../../lib/visualization/scanline-fill";
import type { TerrainIsland } from "../../lib/visualization/terrain";
import type { WorldTerrain } from "../../lib/visualization/world-terrain";

/**
 * The world terrain as one vertex lattice, refined where there is land.
 * The coarse lattice is the world grid's cell centres, where the seabed is
 * already as fine as the field. Islands are only a few cells deep there, so
 * every lattice quad near a coast is split `refine` times a side, and land
 * at its vertices is sampled from each island's landform directly, over
 * inland distance measured on a raster at the fine spacing. Positions are
 * in map units, row 0 at the chart's top, as the field's are.
 *
 * A refined region's outer quads are all sea, where the fine vertices
 * sample the same bilinear seabed that the coarse edges interpolate: along
 * a line between two cell centres that is exactly linear, so the fine and
 * coarse vertices meet on the edge and the lattice has no cracks.
 */
export interface LatticeSettings {
  /** Coarse cells around any land within which a quad is refined. */
  margin: number;
  /** Fine quads along each side of a refined coarse quad. */
  refine: number;
  /**
   * Elevation units every vertex keeps from the water level: land at least
   * this far above it, sea at least this far below, so no vertex lies on it.
   */
  waterGap: number;
}

export interface GeologyLattice {
  /** Vertices: the coarse lattice first, row-major, then the fine ones. */
  count: number;
  /** Each vertex's elevation, in `geologyLevels` units. */
  elevation: Float32Array;
  /** Each vertex's elevation gradient per map unit, x then y. */
  gradient: Float32Array;
  /** Three vertex indices a triangle, wound anticlockwise in world space. */
  index: Uint32Array;
  /** The world terrain's island ids, which `owner` indexes. */
  islandIds: readonly string[];
  /** Index into `islandIds` of each land vertex's island; -1 at sea. */
  owner: Int32Array;
  /** Each vertex's map position, x then y. */
  points: Float32Array;
  /** Coarse quads that were refined. */
  refined: number;
}

/** One island's land on the fine lattice: map units inland by raster cell, -1 at water. */
interface LandRaster {
  column: number;
  height: number;
  inland: Float32Array;
  owner: number;
  row: number;
  width: number;
}

/** The fine lattice's spacing and origin over the world grid. */
interface Lattice {
  /** Map units between fine vertices. */
  step: number;
  /** Map position of lattice point (0, 0): the first cell's centre. */
  x0: number;
  y0: number;
}

/** An island's coast rasterised on the fine lattice, two cells of water around it. */
function landRaster(
  island: TerrainIsland,
  owner: number,
  lattice: Lattice
): LandRaster | undefined {
  const points = island.coast.flatMap((polygon) => polygon[0] ?? []);
  if (!points.length) {
    return;
  }
  const { step, x0, y0 } = lattice;
  const xs = points.map(([x]) => (island.x + x - x0) / step);
  const ys = points.map(([, y]) => (island.y + y - y0) / step);
  const column = Math.floor(Math.min(...xs)) - 2;
  const row = Math.floor(Math.min(...ys)) - 2;
  const width = Math.ceil(Math.max(...xs)) + 3 - column;
  const height = Math.ceil(Math.max(...ys)) + 3 - row;
  const land = new Uint8Array(width * height);
  // Raster cell `a` is centred on lattice point `column + a`.
  for (const polygon of island.coast) {
    fillPolygon(
      land,
      width,
      height,
      polygon.map((ring) =>
        ring.map(([x, y]): [number, number] => [
          (island.x + x - x0) / step - column + 0.5,
          (island.y + y - y0) / step - row + 0.5,
        ])
      )
    );
  }
  const water = Uint8Array.from(land, (cell) => 1 - cell);
  const distances = shoreDistances(water, width, height);
  // A cell's centre sits half a cell from the boundary between land and water.
  const inland = Float32Array.from(land, (cell, at) =>
    cell ? Math.max(0, (distances[at] ?? 0) - 0.5) * step : -1
  );
  return { column, height, inland, owner, row, width };
}

/** Flags every coarse quad with a corner within `margin` cells of land. */
function refinedQuads(world: WorldTerrain, margin: number): Uint8Array {
  const { cell, height, signedDistance, width } = world;
  const reach = margin * cell;
  const flags = new Uint8Array((width - 1) * (height - 1));
  for (let row = 0; row < height - 1; row += 1) {
    for (let column = 0; column < width - 1; column += 1) {
      const at = row * width + column;
      const nearest = Math.min(
        signedDistance[at] ?? Number.POSITIVE_INFINITY,
        signedDistance[at + 1] ?? Number.POSITIVE_INFINITY,
        signedDistance[at + width] ?? Number.POSITIVE_INFINITY,
        signedDistance[at + width + 1] ?? Number.POSITIVE_INFINITY
      );
      if (nearest < reach) {
        flags[row * (width - 1) + column] = 1;
      }
    }
  }
  return flags;
}

/**
 * Elevation and owner at any fine lattice point, memoised: an island's
 * landform where its raster holds land, the first island by id winning, and
 * otherwise the seabed under the water gap. The seabed is the world field
 * with its land cells at the water level, so it meets every coast near 0
 * rather than climbing toward the coarse land.
 */
function fineField(
  world: WorldTerrain,
  rasters: readonly LandRaster[],
  landform: Landform,
  lattice: Lattice,
  settings: LatticeSettings
) {
  const seabed = Float32Array.from(world.elevation, (value, at) =>
    (world.signedDistance[at] ?? 0) < 0 ? geologyLevels.waterLevel : value
  );
  const stride = (world.width - 1) * settings.refine + 1;
  const memo = new Map<number, number>();
  /** The first raster by island id that holds land at a lattice point, and how far inland. */
  const landAt = (
    column: number,
    row: number
  ): { inland: number; owner: number } | undefined => {
    for (const raster of rasters) {
      const c = column - raster.column;
      const r = row - raster.row;
      if (c >= 0 && r >= 0 && c < raster.width && r < raster.height) {
        const inland = raster.inland[r * raster.width + c] ?? -1;
        if (inland >= 0) {
          return { inland, owner: raster.owner };
        }
      }
    }
  };
  const evaluate = (column: number, row: number): number => {
    const x = lattice.x0 + column * lattice.step;
    const y = lattice.y0 + row * lattice.step;
    const land = landAt(column, row);
    if (land) {
      const height = landform({
        inland: land.inland,
        islandId: world.islandIds[land.owner] ?? "",
        x,
        y,
      });
      return Math.min(geologyLevels.land, Math.max(settings.waterGap, height));
    }
    return Math.min(-settings.waterGap, sampleGrid(world, seabed, x, y));
  };
  const elevation = (column: number, row: number): number => {
    const key = row * stride + column;
    let value = memo.get(key);
    if (value === undefined) {
      value = evaluate(column, row);
      memo.set(key, value);
    }
    return value;
  };
  const owner = (column: number, row: number) =>
    landAt(column, row)?.owner ?? -1;
  return { elevation, owner };
}

type FineField = ReturnType<typeof fineField>;

/**
 * The lattice's triangles: two a coarse quad, or two for each of a refined
 * quad's fine quads. A fine vertex that falls on a coarse one is the coarse
 * one; the others are numbered after the coarse lattice as they are met.
 */
function latticeIndex(world: WorldTerrain, flags: Uint8Array, refine: number) {
  const { height, width } = world;
  let refined = 0;
  for (const flag of flags) {
    refined += flag;
  }
  const coarse = width * height;
  const quads = (width - 1) * (height - 1);
  const index = new Uint32Array(
    (quads - refined) * 6 + refined * refine * refine * 6
  );
  const fine = new Map<number, number>();
  const fineCoords: number[] = [];
  const stride = (width - 1) * refine + 1;
  const vertex = (column: number, row: number): number => {
    if (column % refine === 0 && row % refine === 0) {
      return (row / refine) * width + column / refine;
    }
    const key = row * stride + column;
    let id = fine.get(key);
    if (id === undefined) {
      id = coarse + fineCoords.length / 2;
      fine.set(key, id);
      fineCoords.push(column, row);
    }
    return id;
  };
  let next = 0;
  // Corners a, b on the quad's top edge and c, d below them, in map rows;
  // world y is map y turned over, so (a, c, b) and (b, c, d) wind anticlockwise.
  const quad = (a: number, b: number, c: number, d: number) => {
    index.set([a, c, b, b, c, d], next);
    next += 6;
  };
  const refinedQuad = (column: number, row: number) => {
    for (let j = 0; j < refine; j += 1) {
      for (let i = 0; i < refine; i += 1) {
        const c = column * refine + i;
        const r = row * refine + j;
        quad(
          vertex(c, r),
          vertex(c + 1, r),
          vertex(c, r + 1),
          vertex(c + 1, r + 1)
        );
      }
    }
  };
  for (let row = 0; row < height - 1; row += 1) {
    for (let column = 0; column < width - 1; column += 1) {
      if (flags[row * (width - 1) + column]) {
        refinedQuad(column, row);
      } else {
        const at = row * width + column;
        quad(at, at + 1, at + width, at + width + 1);
      }
    }
  }
  return { fineCoords, index, refined };
}

/** Every vertex's elevation, gradient and owner, as the field gives them. */
interface LatticeValues {
  elevation: Float32Array;
  gradient: Float32Array;
  owner: Int32Array;
}

/** Writes one vertex sampled from the fine field, its gradient by central differences on the fine lattice. */
function sampleFine(
  values: LatticeValues,
  field: FineField,
  limits: { columns: number; rows: number; step: number },
  vertex: { column: number; id: number; row: number }
): void {
  const { column, id, row } = vertex;
  values.elevation[id] = field.elevation(column, row);
  values.owner[id] = field.owner(column, row);
  const east = Math.min(limits.columns, column + 1);
  const west = Math.max(0, column - 1);
  const south = Math.min(limits.rows, row + 1);
  const north = Math.max(0, row - 1);
  values.gradient[id * 2] =
    (field.elevation(east, row) - field.elevation(west, row)) /
    (Math.max(1, east - west) * limits.step);
  values.gradient[id * 2 + 1] =
    (field.elevation(column, south) - field.elevation(column, north)) /
    (Math.max(1, south - north) * limits.step);
}

/** One coarse vertex's map position, its outer ring taken out to `half`. */
function coarsePoint(
  world: WorldTerrain,
  column: number,
  row: number,
  half: { height: number; width: number }
): [number, number] {
  const x = world.left + (column + 0.5) * world.cell;
  const y = world.top + (row + 0.5) * world.cell;
  const edgeX = column === 0 ? -half.width : half.width;
  const edgeY = row === 0 ? -half.height : half.height;
  return [
    column === 0 || column === world.width - 1 ? edgeX : x,
    row === 0 || row === world.height - 1 ? edgeY : y,
  ];
}

/**
 * The world terrain's vertex lattice. `extent`, when it is wider than the
 * grid, takes the lattice's outer ring out to it: the field is open abyss
 * there, so one ring of long quads carries the seabed to the sea's edge.
 */
export function geologyLattice(options: {
  extent?: { height: number; width: number };
  islands: readonly TerrainIsland[];
  landform: Landform;
  settings: LatticeSettings;
  world: WorldTerrain;
}): GeologyLattice {
  const { extent, landform, settings, world } = options;
  const { cell, height, width } = world;
  const refine = Math.max(1, Math.round(settings.refine));
  const lattice: Lattice = {
    step: cell / refine,
    x0: world.left + cell / 2,
    y0: world.top + cell / 2,
  };
  const islandIndex = new Map(world.islandIds.map((id, at) => [id, at]));
  const rasters = [...options.islands]
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap((island) => {
      const raster = landRaster(
        island,
        islandIndex.get(island.id) ?? -1,
        lattice
      );
      return raster ? [raster] : [];
    });
  const field = fineField(world, rasters, landform, lattice, {
    ...settings,
    refine,
  });
  const { fineCoords, index, refined } = latticeIndex(
    world,
    refinedQuads(world, settings.margin),
    refine
  );
  const coarse = width * height;
  const count = coarse + fineCoords.length / 2;
  const points = new Float32Array(count * 2);
  const values: LatticeValues = {
    elevation: new Float32Array(count),
    gradient: new Float32Array(count * 2),
    owner: new Int32Array(count).fill(-1),
  };
  const limits = {
    columns: (width - 1) * refine,
    rows: (height - 1) * refine,
    step: lattice.step,
  };
  const half = {
    height: Math.max(height * cell, extent?.height ?? 0) / 2,
    width: Math.max(width * cell, extent?.width ?? 0) / 2,
  };
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const id = row * width + column;
      points.set(coarsePoint(world, column, row, half), id * 2);
      // Near a coast a coarse vertex may be land, so the fine field samples it.
      if ((world.signedDistance[id] ?? 0) < 2 * cell) {
        sampleFine(values, field, limits, {
          column: column * refine,
          id,
          row: row * refine,
        });
        continue;
      }
      values.elevation[id] = Math.min(
        -settings.waterGap,
        world.elevation[id] ?? 0
      );
      values.gradient.set(
        world.gradient(lattice.x0 + column * cell, lattice.y0 + row * cell),
        id * 2
      );
    }
  }
  for (let at = 0; at < fineCoords.length; at += 2) {
    const column = fineCoords[at] ?? 0;
    const row = fineCoords[at + 1] ?? 0;
    const id = coarse + at / 2;
    points[id * 2] = lattice.x0 + column * lattice.step;
    points[id * 2 + 1] = lattice.y0 + row * lattice.step;
    sampleFine(values, field, limits, { column, id, row });
  }
  return {
    count,
    ...values,
    index,
    islandIds: world.islandIds,
    points,
    refined,
  };
}
