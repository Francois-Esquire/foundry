/**
 * The world plan: the contract between the planner (world-plan.ts
 * `planWorld`) and the layers that draw it (WORLD.md). The plan is made
 * on the CPU when the chart changes and then fixed. Every layer reads it:
 * the zoning bake, the surfaces, the structures and the foliage.
 *
 * Everything is in chart units, about four metres a unit. A turn follows
 * town-parts.ts: local z turns toward −x by `turn`, so local (x, z) lands
 * at (cos·x − sin·z, sin·x + cos·z) from the thing's middle.
 */
import type { Frame, FramePass, Target, Texture } from "vgpu";
import type { Point } from "../../../data/chart";
import type { DebrisLight } from "../land/debris";
import type { MapName } from "../maps/map-params";
import type { MapFrame } from "../maps/map-uniforms";

/** How big a road is (TOWNS.md rule 2). */
export type RoadRank = "main" | "street" | "lane" | "path";

/** Chart units, edge to edge. */
export const ROAD_WIDTH: Readonly<Record<RoadRank, number>> = {
	main: 2.5,
	street: 1.5,
	lane: 1,
	path: 0.5,
};

export interface Road {
	/** The folder it serves, workspace-relative, or null for a connector or path. */
	readonly folder: string | null;
	/** Its index in `WorldPlan.roads`. */
	readonly id: number;
	readonly island: string;
	/**
	 * Its centreline, at least two points, finely enough sampled that a
	 * ribbon along it bends smoothly (no gap over 2 units). Ends that meet
	 * another road lie on that road's centreline.
	 */
	readonly points: readonly Point[];
	readonly rank: RoadRank;
	readonly width: number;
}

/** What a parcel's ground is (WORLD.md layer 3). */
export type ParcelKind =
	| "lot"
	| "plaza"
	| "pitch"
	| "playground"
	| "track"
	| "field"
	| "garden"
	| "shrine"
	| "parking";

export interface Parcel {
	/** What bounds it on the sides away from the road. */
	readonly edge: "none" | "wall" | "hedge" | "fence";
	readonly id: number;
	readonly island: string;
	readonly kind: ParcelKind;
	/** Its outline, counter-clockwise, convex or nearly so. */
	readonly outline: readonly Point[];
	/** The road it fronts, or null. */
	readonly road: number | null;
}

/** What stands on a parcel (TOWNS.md rules 3 to 5). */
export type BuildingKind =
	| "house"
	| "pair"
	| "walkup"
	| "block"
	| "tower"
	| "store"
	| "civic"
	| "station"
	| "school"
	| "utility"
	| "shrine"
	| "stand"
	| "boathouse"
	| "lighthouse";

export interface Building {
	/** Its footprint's middle; it stands inside its parcel with a setback. */
	readonly at: Point;
	/** Its files, by module id: one household each, or one seat in a stand. */
	readonly files: readonly string[];
	/** Half its footprint across (local x) and deep (local z). */
	readonly half: readonly [number, number];
	readonly id: number;
	readonly island: string;
	readonly kind: BuildingKind;
	readonly parcel: number;
	/** Floors; 0 for a stand or anything without floors. */
	readonly storeys: number;
	/** Radians: its front (door) faces its road along local +z. */
	readonly turn: number;
}

/** Land the plan sets aside for a purpose, by outline. */
export type ZoneKind =
	| "core"
	| "garden"
	| "field"
	| "grove"
	| "pines"
	| "meadow"
	| "shore";

export interface Zone {
	readonly island: string;
	readonly kind: ZoneKind;
	readonly outline: readonly Point[];
}

/** A tree the plan places by name: street trees, the grove, the pines. */
export interface PlannedTree {
	readonly at: Point;
	readonly kind: "street" | "grove" | "pine" | "garden";
	/** Chart units, crown radius. */
	readonly size: number;
}

export interface WorldPlan {
	/** Each module's building, by module id: where the file now stands. */
	readonly buildingOf: ReadonlyMap<string, number>;
	readonly buildings: readonly Building[];
	readonly parcels: readonly Parcel[];
	/** Utility poles, along the lanes; wires run between neighbours on one road. */
	readonly poles: readonly { readonly at: Point; readonly road: number }[];
	readonly roads: readonly Road[];
	readonly trees: readonly PlannedTree[];
	readonly zones: readonly Zone[];
}

/**
 * The zoning map's channels (WORLD.md layer 2): rgba8unorm at the maps'
 * resolution, baked from the plan. Shaders name the same channels.
 */
export const ZONING_CHANNELS = {
	reserved: "r",
	trees: "g",
	shrubs: "b",
	open: "a",
} as const;

/**
 * A drawn layer of the world (WORLD.md layers 3 to 5), as the scene holds
 * it: packed when the plan changes, settled on the baked maps when they
 * change, drawn into the film every frame with no layout of its own.
 */
export interface WorldLayer {
	compile: (film: Target) => Promise<void>;
	dispose: () => void;
	/** Draws into the film pass: depth tested, reversed-Z, `compare: "greater"`. */
	draw: (pass: FramePass, light: DebrisLight, grid: MapFrame) => void;
	/** Packs what it needs from the plan; GPU work waits for `settle`. */
	set: (plan: WorldPlan) => void;
	/**
	 * Encodes into `frame` whatever it bakes from the maps (ground heights,
	 * a scatter), only when the plan or a map it reads changed since it
	 * last did. Constant time otherwise.
	 */
	settle: (
		frame: Frame,
		grid: MapFrame,
		textures: Readonly<Record<MapName, Texture>>
	) => void;
}
