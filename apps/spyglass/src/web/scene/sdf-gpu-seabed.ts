import {
  Fn,
  float,
  floor,
  If,
  instanceIndex,
  int,
  max,
  min,
  select,
  smoothstep,
  storage,
  uint,
  vec3,
  vec4,
  vertexIndex,
} from "three/tsl";
import { type Node, StorageBufferAttribute } from "three/webgpu";
import { geologyLevels } from "../../lib/visualization/geology";
import { defaultLagoonSettings } from "../../lib/visualization/lagoons";
import {
  kernelElevationAtDepth,
  kernelInletChannel,
} from "../../lib/visualization/terrain-kernel-lagoon";
import { lagoonOffset } from "../../lib/visualization/terrain-kernel-landform";
import { kernelNoise } from "../../lib/visualization/terrain-kernel-noise";
import type { TrialPlan } from "../layout/sdf-trial";
import {
  coastNode,
  islandRecordReader,
  type ScreenTerrainInputs,
  seabedNode,
} from "./screen-terrain-bake";
import { decodeNormal, encodeNormal, vertexTexels } from "./sdf-gpu-mesh";
import { nodeMath } from "./terrain-kernel-tsl";

/**
 * The SDF trial's seabed beyond the islands' regions: the chart's seabed
 * as a height field on a regular grid, computed on the GPU as the bake
 * composes it (every coast measured exactly, an atoll's inlets cut past
 * its coast, other land held at the water level), sunk a hair under each
 * island's region so the island's own ground covers it there, and lit by
 * marching its heights toward the sun. Drawn with no index buffer: a
 * vertex's grid corner follows from the draw's vertex index.
 */

/** Map units between the grid's vertices. */
const gridSpacing = 2;

/** World units the grid sinks under an island's region, and map units beyond it over which the sink eases out. */
const sink = { depth: 0.04, fade: 6 };

/** World units of the sun's direction, as the preview's light. */
const sun = (() => {
  const length = Math.hypot(-600, 700, 700);
  return [-600 / length, 700 / length, 700 / length] as const;
})();

export function seabedGrid(plan: TrialPlan, inputs: ScreenTerrainInputs) {
  const { world } = plan.chart;
  const span = world.width * world.cell;
  const side = Math.floor(span / gridSpacing) + 1;
  const count = side * side;
  const attribute = new StorageBufferAttribute(
    new Float32Array(count * vertexTexels * 4),
    4
  );
  const vertices = storage(attribute, "vec4", count * vertexTexels);
  const X = plan.islands[0]?.slabs.exaggeration ?? 14;
  const grid = {
    cell: world.cell,
    height: world.height,
    left: world.left,
    top: world.top,
    width: world.width,
  };
  const noise = kernelNoise(nodeMath);
  /** Map units outside the nearest island's region, 0 within one. */
  const outsideRegions = (x: Node<"float">, y: Node<"float">) =>
    plan.islands.reduce<Node<"float">>((nearest, island) => {
      const dx = max(
        max(float(island.left).sub(x), x.sub(island.left + island.width)),
        0
      );
      const dy = max(
        max(float(island.top).sub(y), y.sub(island.top + island.height)),
        0
      );
      return min(nearest, dx.mul(dx).add(dy.mul(dy)).sqrt());
    }, float(1e9));

  const heightsPass = Fn(() => {
    const index = instanceIndex.toVar();
    const column = index.mod(uint(side));
    const row = index.div(uint(side));
    const x = float(column).mul(gridSpacing).add(world.left).toVar();
    const y = float(row).mul(gridSpacing).add(world.top).toVar();
    const coast = coastNode(inputs, x, y);
    const distance = coast.distance.toVar();
    const owner = coast.owner.toVar();
    const elevation = seabedNode(
      inputs,
      grid,
      { x, y },
      max(distance, 0)
    ).toVar();
    const { read, readAt } = islandRecordReader(
      inputs,
      int(max(owner, 0)).toVar()
    );
    If(distance.greaterThanEqual(0).and(owner.greaterThanEqual(0)), () => {
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
        elevation.assign(
          min(elevation, kernelElevationAtDepth(nodeMath, channel))
        );
      });
    });
    // Other land is held at the water level: the islands are meshed apart.
    const fade = smoothstep(0, sink.fade, outsideRegions(x, y));
    const z = min(elevation, geologyLevels.waterLevel)
      .mul(X)
      .sub(fade.oneMinus().mul(sink.depth));
    vertices.element(index.mul(vertexTexels)).assign(vec4(x, y.negate(), z, 1));
  })().compute(count);

  /** The grid's height (world units) at a map position, bilinear. */
  const heightAt = (x: Node<"float">, y: Node<"float">) => {
    const u = x.sub(world.left).div(gridSpacing);
    const v = y.sub(world.top).div(gridSpacing);
    const column = floor(u).clamp(0, side - 2);
    const row = floor(v).clamp(0, side - 2);
    const s = u.sub(column).clamp(0, 1);
    const t = v.sub(row).clamp(0, 1);
    const first = uint(row.mul(side).add(column));
    const at = (offset: Node<"uint">) =>
      vertices.element(offset.mul(vertexTexels)).z;
    const top = at(first)
      .mul(s.oneMinus())
      .add(at(first.add(1)).mul(s));
    const bottom = at(first.add(side))
      .mul(s.oneMinus())
      .add(at(first.add(side + 1)).mul(s));
    return top.mul(t.oneMinus()).add(bottom.mul(t));
  };

  const lightPass = Fn(() => {
    const index = instanceIndex.toVar();
    const own = vertices.element(index.mul(vertexTexels)).toVar();
    const x = own.x.toVar();
    const y = own.y.negate().toVar();
    const h = float(gridSpacing);
    const gx = heightAt(x.add(h), y)
      .sub(heightAt(x.sub(h), y))
      .div(h.mul(2));
    // Down the chart is down the world's y.
    const gy = heightAt(x, y.sub(h))
      .sub(heightAt(x, y.add(h)))
      .div(h.mul(2));
    const normal = vec3(gx.negate(), gy.negate(), 1).normalize();
    const worst = float(0).toVar();
    let t = 0.6;
    while (t < 80) {
      const ray = own.z.add(0.05).add(sun[2] * t);
      const ground = heightAt(x.add(sun[0] * t), y.sub(sun[1] * t));
      worst.assign(max(worst, ground.sub(ray).div(0.25 + 0.12 * t)));
      t *= 1.25;
    }
    const s = worst.clamp(0, 1);
    const lit = float(1).sub(s.mul(s).mul(s.mul(-2).add(3)));
    const sum = float(0).toVar();
    for (const radius of [8, 16, 32]) {
      const mean = float(0).toVar();
      for (const dx of [-1, -0.5, 0, 0.5, 1]) {
        for (const dy of [-1, -0.5, 0, 0.5, 1]) {
          mean.addAssign(heightAt(x.add(dx * radius), y.add(dy * radius)));
        }
      }
      sum.addAssign(mean.div(25).sub(own.z));
    }
    vertices
      .element(index.mul(vertexTexels).add(1))
      .assign(vec4(encodeNormal(normal), lit, sum.div(3 * X)));
  })().compute(count);

  /** The drawn vertex: two triangles a grid square, winding anticlockwise from above. */
  const pulled = () => {
    const read = storage(attribute, "vec4", count * vertexTexels).toReadOnly();
    const quad = vertexIndex.div(6);
    const corner = int(vertexIndex.mod(6));
    const column = quad.mod(uint(side - 1));
    const row = quad.div(uint(side - 1));
    // Corners a, d, b then a, c, d, as column and row offsets.
    const dc = select(
      corner
        .equal(int(1))
        .or(corner.equal(int(2)))
        .or(corner.equal(int(5))),
      uint(1),
      uint(0)
    );
    const dr = select(
      corner
        .equal(int(1))
        .or(corner.equal(int(4)))
        .or(corner.equal(int(5))),
      uint(1),
      uint(0)
    );
    const id = row.add(dr).mul(side).add(column.add(dc));
    const position = read.element(id.mul(vertexTexels));
    const extra = read.element(id.mul(vertexTexels).add(1));
    return {
      normal: decodeNormal(extra.xy),
      position: position.xyz,
      shade: vec3(position.w, extra.z, extra.w),
    };
  };

  return {
    /** The grid's bounds, world units, for the water over it. */
    bounds: {
      bottom: -(world.top + span),
      left: world.left,
      right: world.left + span,
      top: -world.top,
    },
    bytes: attribute.array.byteLength,
    /** The grid's height (world units) at a map position, for a compute pass. */
    heightAt,
    heightsPass,
    lightPass,
    pulled,
    /** Vertices the grid's draw takes. */
    vertexCount: (side - 1) * (side - 1) * 6,
  };
}

export type SeabedGrid = ReturnType<typeof seabedGrid>;
