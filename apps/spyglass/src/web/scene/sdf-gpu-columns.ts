import {
  Fn,
  float,
  floor,
  If,
  instanceIndex,
  int,
  ivec2,
  max,
  min,
  select,
  storage,
  textureLoad,
  vec4,
} from "three/tsl";
import type { Node } from "three/webgpu";
import { defaultLagoonSettings } from "../../lib/visualization/lagoons";
import {
  kernelElevationAtDepth,
  kernelInletChannel,
} from "../../lib/visualization/terrain-kernel-lagoon";
import {
  kernelWorldLandform,
  lagoonOffset,
} from "../../lib/visualization/terrain-kernel-landform";
import { kernelNoise } from "../../lib/visualization/terrain-kernel-noise";
import type { ChartWorld } from "../layout/chart-world";
import {
  islandRecordReader,
  type ScreenTerrainInputs,
  seabedNode,
  wrappedTexel,
} from "./screen-terrain-bake";
import {
  columnIndex,
  columnOf,
  columnPoint,
  countLoop,
  type IslandScratch,
  type IslandUniforms,
} from "./sdf-gpu-island";
import { nodeMath } from "./terrain-kernel-tsl";

/**
 * The SDF trial's column passes: everything the slab kernel reads at each
 * lattice column of an island, as `sdf-island.ts` builds it on the CPU.
 *
 * 1. **Fields.** The exact distance to the island's own coast (its own
 *    segments only, so a neighbour inside the margin never stands in for
 *    it; land by an even–odd ray), the land's elevation by the landform
 *    kernel inside it, and the ground: the seabed read at the coast's
 *    distance, an atoll's inlets cut in, under the land too. Also each
 *    contour the footprints are measured from: the lagoon's shore and each
 *    escarpment's middle height.
 * 2. **Footprints** (`sdf-gpu-contours.ts`): each contour traced by
 *    marching squares in the cells round a column and measured exactly.
 * 3. **Columns**: the normalisations by central differences, packed.
 */

/** Map units a column stands from the coast where it is far off, as the CPU holds it. */
const farFromCoast = 10_000;

/** The column storages a pass reads and writes. */
export function columnStorages(scratch: IslandScratch, maxColumns: number) {
  return {
    columns: storage(scratch.columns, "vec4", maxColumns * 3),
    contours: storage(scratch.contours, "vec4", maxColumns),
    distances: storage(scratch.distances, "vec4", maxColumns),
    raw: storage(scratch.raw, "vec4", maxColumns),
    surface: storage(scratch.surface, "float", maxColumns),
  };
}

export type ColumnStorages = ReturnType<typeof columnStorages>;

/**
 * The signed distance to the island's own coast at a map position: the
 * nearest of its segments, negative where a ray toward +x crosses its
 * rings an odd number of times.
 */
function ownCoast(
  inputs: ScreenTerrainInputs,
  uniforms: IslandUniforms,
  x: Node<"float">,
  y: Node<"float">
): Node<"float"> {
  const nearest = float(1e12).toVar();
  const inside = float(0).toVar();
  countLoop(
    "segment",
    int(uniforms.segmentStart),
    int(uniforms.segmentEnd),
    (segment) => {
      const ends = wrappedTexel(inputs.textures.segments, segment);
      const ax = ends.x.sub(x).toVar();
      const ay = ends.y.sub(y).toVar();
      const dx = ends.z.sub(ends.x).toVar();
      const dy = ends.w.sub(ends.y).toVar();
      const t = ax
        .negate()
        .mul(dx)
        .sub(ay.mul(dy))
        .div(max(dx.mul(dx).add(dy.mul(dy)), 1e-12))
        .clamp(0, 1);
      const ex = ax.add(t.mul(dx));
      const ey = ay.add(t.mul(dy));
      nearest.assign(min(nearest, ex.mul(ex).add(ey.mul(ey))));
      // The ray from the point toward +x: the segment straddles its line
      // and crosses it ahead of the point.
      const by = ay.add(dy);
      const straddles = ay.greaterThan(0).xor(by.greaterThan(0));
      const crossing = ax.sub(ay.mul(dx).div(select(straddles, dy, float(1))));
      If(straddles.and(crossing.greaterThan(0)), () => {
        inside.assign(float(1).sub(inside));
      });
    }
  );
  const distance = min(nearest.sqrt(), farFromCoast);
  return select(inside.greaterThan(0.5), distance.negate(), distance);
}

/** Pass 1: each column's land, ground and coast distance, and its contour values. */
export function fieldsPass(options: {
  chart: ChartWorld;
  inputs: ScreenTerrainInputs;
  storages: ColumnStorages;
  uniforms: IslandUniforms;
}) {
  const { chart, inputs, storages, uniforms } = options;
  const { world } = chart;
  const grid = {
    cell: world.cell,
    height: world.height,
    left: world.left,
    top: world.top,
    width: world.width,
  };
  const noise = kernelNoise(nodeMath);
  const middle = (slab: number) =>
    uniforms.profile[slab * 5 + 2] as Node<"float">;
  const exaggeration = uniforms.profile[21] as Node<"float">;
  return Fn(() => {
    const index = instanceIndex.toVar();
    const { column, row } = columnOf(index, uniforms.columns);
    const point = columnPoint(column, row, uniforms);
    const x = point.x.toVar();
    const y = point.y.toVar();
    const coast = ownCoast(inputs, uniforms, x, y).toVar();
    const island = int(uniforms.island).toVar();
    const { read, readAt } = islandRecordReader(inputs, island);
    // Inside the coast the seabed is read at the coast itself, so the
    // ground meets the land there rather than diving under it.
    const seabed = seabedNode(inputs, grid, { x, y }, max(coast, 0)).toVar();
    const channel = kernelInletChannel(
      nodeMath,
      noise,
      {
        read: (slot) => read(lagoonOffset + slot),
        readAt: (slot) => readAt(slot.add(lagoonOffset)),
      },
      { x, y },
      defaultLagoonSettings
    );
    If(channel.greaterThan(0), () => {
      seabed.assign(min(seabed, kernelElevationAtDepth(nodeMath, channel)));
    });
    const land = min(0, seabed).toVar();
    const ground = seabed.toVar();
    If(coast.lessThan(0), () => {
      const cell = ivec2(
        int(floor(x.sub(grid.left).div(grid.cell)).clamp(0, grid.width - 1)),
        int(floor(y.sub(grid.top).div(grid.cell)).clamp(0, grid.height - 1))
      );
      const height = kernelWorldLandform(
        nodeMath,
        noise,
        { read, readAt },
        {
          inland: coast.negate(),
          pieceDepth: textureLoad(inputs.textures.piece, cell).x,
          x,
          y,
        },
        defaultLagoonSettings
      ).toVar();
      land.assign(height);
      ground.assign(min(min(height, 0), seabed));
    });
    // The lagoon's shore: the land within the coast against the water,
    // the sea counting as water too; inside (≥ 0) on the water.
    const shore = select(
      uniforms.hasLagoon.greaterThan(0.5),
      select(coast.lessThan(0), land.negate(), float(1)),
      float(-1)
    );
    storages.raw.element(index).assign(vec4(land, ground, coast, 0));
    storages.contours
      .element(index)
      .assign(
        vec4(
          shore,
          land.sub(middle(1).div(exaggeration)),
          land.sub(middle(2).div(exaggeration)),
          land.sub(middle(3).div(exaggeration))
        )
      );
  });
}

/**
 * Pass 3: the kernel's columns. Each normalisation is `1 / √(1 + |∇h|²)`
 * of its surface by central differences, one-sided at the lattice's edge
 * (as `slopeLength`): the ground's, and each slab's tread clamped to its
 * band. Also the column's surface height, the slabs' and the ground's
 * without the blends, which the light reads.
 */
export function columnsPass(options: {
  storages: ColumnStorages;
  uniforms: IslandUniforms;
}) {
  const { storages, uniforms } = options;
  const profile = (slot: number) => uniforms.profile[slot] as Node<"float">;
  const exaggeration = profile(21);
  return Fn(() => {
    const index = instanceIndex.toVar();
    const { column, row } = columnOf(index, uniforms.columns);
    const c = float(column).toVar();
    const r = float(row).toVar();
    const raw = storages.raw.element(index).toVar();
    const near = (dc: number, dr: number) =>
      storages.raw.element(columnIndex(c.add(dc), r.add(dr), uniforms)).toVar();
    const left = near(-1, 0);
    const right = near(1, 0);
    const up = near(0, -1);
    const down = near(0, 1);
    const wx = min(c.add(1), uniforms.columns.sub(1))
      .sub(max(c.sub(1), 0))
      .mul(uniforms.spacing)
      .toVar();
    const wy = min(r.add(1), uniforms.rows.sub(1))
      .sub(max(r.sub(1), 0))
      .mul(uniforms.spacing)
      .toVar();
    const scale = (height: (texel: Node<"vec4">) => Node<"float">) => {
      const gx = height(right).sub(height(left)).div(wx);
      const gy = height(down).sub(height(up)).div(wy);
      return float(1).div(gx.mul(gx).add(gy.mul(gy)).add(1).sqrt());
    };
    const groundScale = scale((texel) => texel.y.mul(exaggeration));
    const treadScale = (slab: number) =>
      scale((texel) =>
        texel.x
          .clamp(profile(slab * 5), profile(slab * 5 + 1))
          .mul(exaggeration)
      );
    const distances = storages.distances.element(index).toVar();
    const base = index.mul(3);
    storages.columns
      .element(base)
      .assign(
        vec4(raw.x, raw.y.mul(exaggeration), groundScale, uniforms.island)
      );
    storages.columns
      .element(base.add(1))
      .assign(vec4(treadScale(0), treadScale(1), treadScale(2), treadScale(3)));
    storages.columns.element(base.add(2)).assign(distances);
    // The surface's height: the highest slab over the ground.
    const surface = raw.y.mul(exaggeration).toVar();
    for (const [slab, channel] of (["x", "y", "z", "w"] as const).entries()) {
      const tread = raw.x
        .clamp(profile(slab * 5), profile(slab * 5 + 1))
        .mul(exaggeration);
      const wall = profile(slab * 5 + 2).sub(
        distances[channel].add(profile(slab * 5 + 3)).mul(profile(slab * 5 + 4))
      );
      surface.assign(max(surface, min(tread, wall)));
    }
    storages.surface.element(index).assign(surface);
  });
}
