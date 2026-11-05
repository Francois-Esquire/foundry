/**
 * The maps' parameters and their dependency graph: plain data, no GPU. The
 * experiment's `params.ts` mirrors `MapParams` field for field and imports
 * this file, so it must stay free of `vgpu` and `.wgsl` imports.
 */
import {
	DEFAULT_SEA_PARAMS,
	MAP_OF_SEA_MAP_PARAM,
	type SeaMapParams,
	seaMapParamsOf,
} from "../sea/sea-params";

export const MAP_NAMES = [
	"distance",
	"islands",
	"coverage",
	"coasts",
	"height",
	"rings",
	"footprints",
	"flow",
	"light",
	"shade",
	"paint",
	"files",
	"zoning",
] as const;

export type MapName = (typeof MAP_NAMES)[number];

/**
 * The maps with a debug view, in `MAP_NAMES` order: every map but
 * `coasts`, one distance field per island that the height kernel alone
 * reads. terrain.wgsl's `Grid.view` is 1 + a map's index here.
 */
export const VIEWED_MAPS = [
	"distance",
	"islands",
	"coverage",
	"height",
	"rings",
	"flow",
	"light",
	"shade",
	"paint",
	"files",
	"zoning",
] as const satisfies readonly MapName[];

export type ViewedMap = (typeof VIEWED_MAPS)[number];

/**
 * The land's map parameters, sorted by name; `MAP_OF_PARAM` says which map
 * each belongs to. Lengths are chart units unless they say texels.
 */
export interface LandMapParams {
	/** height: the crown's most height over the plate, the top swelling like a bun's. */
	crownHeight: number;
	/** height: how far inland the crown rises most of the way. */
	crownWidth: number;
	/** coverage: texels across the coast's ease. */
	feather: number;
	/** files: a file's disc radius, chart units; never under a texel. */
	fileRadius: number;
	/** height: a thin raised band along the edge, just inside the rim. */
	lipHeight: number;
	/** height: how far inland the lip fades. */
	lipWidth: number;
	/** paint: which of the pastel caps an island takes, by island order or by a hash of the id. */
	palette: "order" | "hash";
	/** height: the land's flat top above sea level. */
	plateHeight: number;
	/** distance: texels a side of every map. */
	resolution: 512 | 1024 | 2048;
	/**
	 * height: chart units over which the rim's distance is eased, so the rim
	 * and lip follow the coast's course without its finest wiggles. The
	 * distance and coverage maps keep the exact coast. 0 for none.
	 */
	rimSmoothing: number;
	/** height: the rise from the coast to the plate. */
	rimWidth: number;
	/** light: radians, clockwise from north (chart −y). */
	sunAzimuth: number;
	/** light: radians above the horizon. */
	sunElevation: number;
	/** World units per bake tile; 0 preserves the chart-fitted original maps. */
	tileWorldSize: number;
}

/**
 * Every map's parameters, flat: the land's and the sea's map side
 * (sea-params.ts `SeaMapParams`). Flat, not a nested `sea` field, because
 * `changedParams` compares values and arrays only.
 */
export type MapParams = LandMapParams & SeaMapParams;

/**
 * Sized for Foundry's chart (about 1250 by 1600 units, islands 40 to 200
 * units across, texels 0.86 units at 2048): a low plate with a fine lip,
 * standing in the sea's wide, gentle bank (sea-params.ts), whose steepest
 * slope is about a quarter, so neighbouring islands share their shallows.
 */
export const DEFAULT_MAP_PARAMS: MapParams = {
	...seaMapParamsOf(DEFAULT_SEA_PARAMS),
	resolution: 2048,
	tileWorldSize: 0,
	feather: 1,
	fileRadius: 1.5,
	plateHeight: 6,
	rimWidth: 3,
	rimSmoothing: 2.5,
	lipHeight: 0.15,
	lipWidth: 2,
	crownHeight: 4,
	crownWidth: 12,
	sunAzimuth: (7 * Math.PI) / 4,
	sunElevation: 0.6,
	palette: "order",
};

/** The map each parameter belongs to. Its dependants rebuild with it. */
export const MAP_OF_PARAM: Record<
	keyof MapParams,
	MapPassName | readonly MapPassName[]
> = {
	...MAP_OF_SEA_MAP_PARAM,
	// The files and zoning maps have no input map, so the frame's own
	// parameters name them.
	resolution: ["distance", "files", "zoning"],
	tileWorldSize: ["distance", "coasts", "files", "zoning"],
	feather: "coverage",
	fileRadius: "files",
	plateHeight: "height",
	rimWidth: "height",
	rimSmoothing: "height",
	lipHeight: "height",
	lipWidth: "height",
	crownHeight: "height",
	crownWidth: "height",
	sunAzimuth: "light",
	sunElevation: "light",
	palette: "paint",
};

/**
 * GPU bake passes in build order. Outputs of one pass always rebuild
 * together; dependencies refer to the passes that produce their inputs.
 */
export const MAP_PASSES = [
	{ name: "distance", inputs: [], outputs: ["distance", "islands"] },
	{ name: "coverage", inputs: ["distance"], outputs: ["coverage"] },
	{ name: "coasts", inputs: [], outputs: ["coasts"] },
	{
		name: "height",
		inputs: ["distance", "coasts"],
		outputs: ["height", "rings", "footprints"],
	},
	{ name: "flow", inputs: ["distance", "height"], outputs: ["flow"] },
	{ name: "light", inputs: ["height"], outputs: ["light", "shade"] },
	{
		name: "paint",
		inputs: ["distance", "coverage", "height"],
		outputs: ["paint"],
	},
	// The chart's modules alone, for now: a disc at each one's place.
	{ name: "files", inputs: [], outputs: ["files"] },
	// The world plan alone (world.ts): what its roads, parcels and zones
	// reserve and grow.
	{ name: "zoning", inputs: [], outputs: ["zoning"] },
] as const satisfies readonly {
	name: MapName;
	inputs: readonly MapName[];
	outputs: readonly MapName[];
}[];

export type MapPass = (typeof MAP_PASSES)[number];
export type MapPassName = MapPass["name"];

/** Changed passes and their dependants, with each pass encoded once. */
export function passesWithDependants(
	changed: Iterable<MapPassName>
): MapPass[] {
	const dirty = new Set(changed);
	return MAP_PASSES.filter((pass) => {
		if (pass.inputs.some((input) => dirty.has(input))) {
			dirty.add(pass.name);
		}
		return dirty.has(pass.name);
	});
}

const sameValue = (
	a: MapParams[keyof MapParams],
	b: MapParams[keyof MapParams]
): boolean => {
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((v, i) => v === b[i]);
	}
	return a === b;
};

/** The parameters whose values differ between two sets. */
export function changedParams(
	before: Readonly<MapParams>,
	after: Readonly<MapParams>
): (keyof MapParams)[] {
	const keys = Object.keys(MAP_OF_PARAM) as (keyof MapParams)[];
	return keys.filter((key) => !sameValue(before[key], after[key]));
}
