import type { LandformArchetype } from "../../lib/visualization/geology";
import {
  defaultSdfIslandSettings,
  islandSlabProfile,
  type SdfIslandSettings,
} from "../../lib/visualization/sdf-island";
import {
  packSlabProfile,
  type SlabProfile,
} from "../../lib/visualization/sdf-kernel";
import { packLandforms } from "../../lib/visualization/terrain-kernel-landform";
import { type ChartWorld, chartWorld } from "./chart-world";

/**
 * The SDF trial's decisions on the CPU, the little the GPU cannot make
 * for itself: which islands are meshed, the region of the world each
 * one's lattice covers, the height range it spans, and its slabs, read
 * from its landform's record. Everything measured, the fields, the
 * meshes and their light, is computed on the GPU from these.
 */

/** One island's region and slabs. */
export interface TrialIslandPlan {
  archetype: LandformArchetype | "ramp";
  /** Whether the island holds an atoll's lagoon, whose shore the bench is measured from too. */
  hasLagoon: boolean;
  /** Map units of the region's height and width; a lattice of spacing `s` has `height / s + 1` rows. */
  height: number;
  id: string;
  /** The island's index among the world's owners, which the coast's bins report. */
  index: number;
  /** The region's west and north edges, map units, on the coarsest lattice. */
  left: number;
  /** The island's slabs packed for the kernel (`packSlabProfile`). */
  packed: number[];
  slabs: SlabProfile;
  top: number;
  width: number;
  /** World heights the surface spans, a little either side. */
  zHigh: number;
  zLow: number;
}

export interface TrialPlan {
  chart: ChartWorld;
  islands: TrialIslandPlan[];
}

/** Map units the coarsest lattice's samples stand apart, to which every region is snapped, so every finer one aligns with it. */
const coarsestSpacing = 1;

/** The coast's bounds of an island, map units. */
function coastBounds(island: ChartWorld["islands"][number]) {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const polygon of island.coast) {
    for (const ring of polygon) {
      for (const [x = 0, y = 0] of ring) {
        left = Math.min(left, island.x + x);
        right = Math.max(right, island.x + x);
        top = Math.min(top, island.y + y);
        bottom = Math.max(bottom, island.y + y);
      }
    }
  }
  return { bottom, left, right, top };
}

/** The lowest elevation of the world grid's cells within a region. */
function lowestWithin(
  world: ChartWorld["world"],
  region: { bottom: number; left: number; right: number; top: number }
): number {
  const column = (x: number) =>
    Math.min(
      world.width - 1,
      Math.max(0, Math.floor((x - world.left) / world.cell))
    );
  const row = (y: number) =>
    Math.min(
      world.height - 1,
      Math.max(0, Math.floor((y - world.top) / world.cell))
    );
  let lowest = 0;
  for (let r = row(region.top); r <= row(region.bottom); r += 1) {
    for (let c = column(region.left); c <= column(region.right); c += 1) {
      lowest = Math.min(lowest, world.elevation[r * world.width + c] ?? 0);
    }
  }
  return lowest;
}

/** The trial's plan for a chart: every island of its world, each in its region. */
export function trialPlan(
  data: Parameters<typeof chartWorld>[0],
  settings: SdfIslandSettings = defaultSdfIslandSettings
): TrialPlan {
  const chart = chartWorld(data);
  const { world } = chart;
  const X = settings.exaggeration;
  const islands = world.islands.map((island): TrialIslandPlan => {
    const index = world.islandIds.indexOf(island.id);
    const bounds = coastBounds(island);
    const left =
      Math.floor((bounds.left - settings.margin) / coarsestSpacing) *
      coarsestSpacing;
    const top =
      Math.floor((bounds.top - settings.margin) / coarsestSpacing) *
      coarsestSpacing;
    const width =
      Math.ceil((bounds.right + settings.margin - left) / coarsestSpacing) *
      coarsestSpacing;
    const height =
      Math.ceil((bounds.bottom + settings.margin - top) / coarsestSpacing) *
      coarsestSpacing;
    const landform = chart.landforms.get(island.id);
    const record = packLandforms(
      chart.landforms,
      [island.id],
      undefined,
      world.lagoons
    );
    const slabs = islandSlabProfile(
      record,
      landform?.params.depth ?? 0,
      settings
    );
    const highest = Math.max(...slabs.slabs.map((slab) => slab.high));
    const lowest = lowestWithin(world, {
      bottom: top + height,
      left,
      right: left + width,
      top,
    });
    return {
      archetype: landform?.archetype ?? "ramp",
      hasLagoon: world.lagoons.some((lagoon) => lagoon.islandId === island.id),
      height,
      id: island.id,
      index,
      left,
      packed: packSlabProfile(slabs),
      slabs,
      top,
      width,
      zHigh: highest * X + 1.5,
      // The seabed's spline and detail can dip a little under its cells.
      zLow: lowest * X - 1.5,
    };
  });
  return { chart, islands };
}
