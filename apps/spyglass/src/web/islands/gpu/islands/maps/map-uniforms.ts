/** Map layout and kernel uniforms, derived without GPU resources. */
import type { Chart, Point } from "../../../data/chart";
import { banksOf } from "../sea/banks";
import {
	breakDepth,
	floorPaintOf,
	seaDepthsOf,
	surfSpeed,
	swellHeading,
	taperOf,
} from "../sea/sea-params";
import { FIELD_EDGE, HEDGE } from "../world/zoning";
import type { PackedBanks } from "./map-data";
import type { MapParams } from "./map-params";
import { clamp01, landUniform, sunDirection } from "./uniforms";

/** The share of the chart's larger side left as sea on every side. */
export const MAP_MARGIN = 0.05;

/** The square grid every map shares. Texel (i, j) is centred at
 * `origin + (i + 0.5, j + 0.5) * texel`. */
export interface MapFrame {
	readonly origin: Point;
	readonly resolution: number;
	readonly texel: number;
}

/** A frame's side, chart units. */
export const sideOf = (mf: MapFrame): number => mf.texel * mf.resolution;

/** A frame's centre, chart units. */
export const centreOf = (mf: MapFrame): Point => {
	const half = sideOf(mf) / 2;
	return [mf.origin[0] + half, mf.origin[1] + half];
};

export function mapFrame(chart: Chart, resolution: number): MapFrame {
	const { width, height } = chart.extent;
	const side = Math.max(width, height) * (1 + 2 * MAP_MARGIN);
	return {
		origin: [-side / 2, -side / 2],
		texel: side / resolution,
		resolution,
	};
}

/** Mip levels down to 1×1 for a power-of-two side. */
export function mipLevelCount(resolution: number): number {
	const levels = Math.log2(resolution) + 1;
	if (!Number.isInteger(levels)) {
		throw new Error(`A map's side must be a power of two, not ${resolution}`);
	}
	return levels;
}

/** Chart units of the light and flow marches' first step, as a share of the frame side. */
const LIGHT_REACH_SHARE = 1 / 1024;

export const frameUniform = (mf: MapFrame) => ({
	origin: mf.origin,
	texel: mf.texel,
	resolution: mf.resolution,
});

/** A riser, and so a ring, is never narrower than this many texels, or it aliases. */
const MIN_RISER_TEXELS = 2.5;

/** The deep's rings past this many are dropped (bathymetry.wgsl `MAX_DEEP_RINGS`). */
const MAX_DEEP_RINGS = 32;
/** Under half a step, so no level's undulation meets its neighbour's (sea/bathymetry.wgsl `undulationAt`). */
const MAX_UNDULATION = 0.45;
/** A unit vector `degrees` from east toward south: chart y runs south. */
const wayOf = (degrees: number): [number, number] => {
	const a = (degrees * Math.PI) / 180;
	return [Math.cos(a), Math.sin(a)];
};

/** The seabed map's side, texels: coarser than the frame's maps, as it lies far off. */
export const SEABED_RESOLUTION = 1024;

/** The share of the seabed map's reach past the frame its outer band eases over. */
const SEABED_BAND = 0.5;

/**
 * Where the open floor starts sinking, chart units from the nearest coast:
 * about where the platform's slope ends, its spread, margin and slope.
 */
export const seascapeCalm = (params: MapParams): number =>
	Math.max(params.bankSpread, 0) +
	Math.max(params.bankMargin, 0) +
	Math.max(params.shelfWidth, 0);

/**
 * The open sea's floor (sea/seascape.wgsl `Seascape`) over the frame `mf`,
 * as the height and seabed kernels share it. It grows in over a slope's
 * width past the calm; its canyons fan out as from a disc the chart's
 * size, half the fitted frame's side less its margins (a tiled frame's is
 * larger, so its canyons fan a little less).
 */
export const seascapeUniform = (params: MapParams, mf: MapFrame) => ({
	basins: Math.max(params.seascapeBasins, 0),
	scale: Math.max(params.seascapeScale, 1),
	veer: clamp01(params.seascapeVeer),
	step: Math.max(params.seascapeStep, 1),
	descent: Math.max(params.seascapeDescent, 0),
	calm: seascapeCalm(params),
	rise: Math.max(params.shelfWidth, 0),
	radius: sideOf(mf) / (2 * (1 + 2 * MAP_MARGIN)),
	sills: clamp01(params.seascapeSills),
	hills: Math.max(params.seascapeHills, 0),
	canyons: Math.max(params.seascapeCanyons, 0),
	faults: Math.max(params.seascapeFaults, 0),
	pits: clamp01(params.seascapePits),
	seed: Math.max(Math.round(params.seascapeSeed), 0),
});

/**
 * The seabed map's square: `seascapeReach` frames across, centred on the
 * frame, `SEABED_RESOLUTION` texels a side. It never holds less than the
 * frame.
 */
export function seabedFrame(mf: MapFrame, params: MapParams): MapFrame {
	const reach = sideOf(mf) * Math.max(params.seascapeReach, 1);
	const centre = centreOf(mf);
	return {
		origin: [centre[0] - reach / 2, centre[1] - reach / 2],
		resolution: SEABED_RESOLUTION,
		texel: reach / SEABED_RESOLUTION,
	};
}

/** How far the seabed map's square reaches past the frame's on each side, chart units. */
const seabedPast = (grid: MapFrame, seabed: MapFrame): number =>
	Math.max((sideOf(seabed) - sideOf(grid)) / 2, 0);

/**
 * The open depth, chart units: what the seabed map's outer band eases the
 * open floor onto, flat, and where the water's open floor lies past the
 * mesh, so the two meet. The deep floor sunk by the descent across the
 * seabed map's reach past the frame, then down to the floor's next whole
 * step (seascape.wgsl `steppedFloor`), so it lies on a tread.
 */
export function openFloorDepth(
	sea: {
		readonly descent: number;
		readonly floorDepth: number;
		readonly step: number;
	},
	grid: MapFrame,
	seabed: MapFrame
): number {
	const descent = Math.max(sea.descent, 0);
	const depth = sea.floorDepth + descent * seabedPast(grid, seabed);
	if (sea.step <= 1 || sea.floorDepth <= 0) {
		return depth;
	}
	const steps = Math.log(depth / sea.floorDepth) / Math.log(sea.step);
	return sea.floorDepth * sea.step ** Math.ceil(steps - 1e-9);
}

/** The seabed kernel's uniforms (seabed.wgsl), for a chart of `levels` levels. */
export function seabedUniforms(
	params: MapParams,
	mf: MapFrame,
	levels: number
) {
	const seabed = seabedFrame(mf, params);
	// The height kernel's bathymetry, so the platform's fall runs on past
	// the frame exactly as it lies within it.
	const { bed, platform, banks, seascape } = heightUniforms(params, mf, {
		bankCount: 0,
		islandCount: 0,
		levels,
	});
	return {
		frame: frameUniform(seabed),
		grid: frameUniform(mf),
		seascape,
		bed,
		platform,
		banks,
		openDepth: openFloorDepth(
			{ ...seascape, floorDepth: bed.floorDepth },
			mf,
			seabed
		),
		band: SEABED_BAND * seabedPast(mf, seabed),
	};
}

/**
 * The height kernel's uniforms. `banks` counts what `packBanks` packed for
 * the chart; without it (or with no groups) the sea is the platform alone,
 * at `bankTop`. The depths are the chart's `seaDepthsOf`.
 */
export function heightUniforms(
	params: MapParams,
	mf: MapFrame,
	banks?: Pick<PackedBanks, "bankCount" | "islandCount" | "levels">
) {
	const levels = banks?.levels ?? 0;
	const depths = seaDepthsOf(params, levels);
	const minRiser = MIN_RISER_TEXELS * mf.texel;
	return {
		frame: frameUniform(mf),
		coastColumns: 1,
		rowStart: 0,
		seascape: seascapeUniform(params, mf),
		land: landUniform(params),
		rimSmoothing: params.rimSmoothing,
		bed: {
			floorDepth: depths.floor,
			slopeWidth: Math.max(params.shelfWidth, 0),
			texel: mf.texel,
		},
		platform: {
			base: depths.platform,
			margin: Math.max(params.bankMargin, 0),
			merge: Math.max(params.bankMerge, 1e-3),
			ragged: Math.max(params.bankRagged, 0),
			scarp: clamp01(params.bankScarp),
			deepRings: Math.min(
				Math.max(Math.round(params.bankDeepRings), 0),
				MAX_DEEP_RINGS
			),
		},
		banks: {
			top: depths.top,
			step: Math.max(params.bankStep, 0),
			taper: taperOf(params),
			run: params.bankRun > 0 ? Math.max(params.bankRun, minRiser) : 0,
			spread: Math.max(params.bankSpread, 0),
			hull: Math.max(params.bankHull, 0),
			bottomReach: Math.max(params.bankBottomReach, 0),
			topReach: Math.min(Math.max(params.bankTopReach, 0), 1),
			slope: Math.max(params.bankSlope, 0),
			minRiser,
			wander: Math.max(params.bankWander, 0),
			lift: clamp01(params.bankLift),
			liftTread: Math.max(params.bankLiftTread, 0),
			undulation: Math.min(Math.max(params.bankUndulation, 0), MAX_UNDULATION),
			undulationLength: Math.max(params.bankUndulationLength, 0),
			undulationWay: wayOf(params.bankUndulationAngle),
			undulationShift: params.bankUndulationShift,
			undulationSteps: Math.max(Math.round(params.bankUndulationSteps), 0),
			undulationBend: Math.max(params.bankUndulationBend, 0),
			bridge: Math.max(params.bankBridge, 0),
			moat: Math.max(params.bankMoat, 0),
			moatAmount: clamp01(params.bankMoatAmount),
			levels,
			islandCount: banks?.islandCount ?? 0,
			bankCount: banks?.bankCount ?? 0,
		},
		beach: {
			width: Math.max(params.bankBeach, mf.texel),
			height: Math.max(params.shoreSandHeight, 0),
			sandDepth: Math.max(params.shoreSandDepth, 0),
			cliffDepth: Math.max(params.shoreCliffDepth, params.shoreSandDepth, 0),
			cliff: Math.max(params.shoreCliffWidth, minRiser),
			smallSand: Math.max(params.shoreSmallSand, 0),
			smallSize: Math.max(params.shoreSmallSize, 1),
			cove: Math.max(params.shoreCove, 0),
			coveDepth: Math.max(params.shoreCoveDepth, 0),
		},
	};
}

/**
 * The paint kernel's uniforms: the colours, the bands at the chart's
 * depths, and the shore's depths, which mark the steep coasts as the
 * height kernel shapes them.
 */
export function paintUniforms(params: MapParams, mf: MapFrame, chart: Chart) {
	const { levels } = banksOf(chart);
	return {
		frame: frameUniform(mf),
		floor: floorPaintOf(params, levels),
		islandCount: chart.islands.length,
		sandDepth: Math.max(params.shoreSandDepth, 0),
		cliffDepth: Math.max(params.shoreCliffDepth, params.shoreSandDepth, 0),
		probe: Math.max(params.bankBeach, mf.texel),
	};
}

/** The flow kernel's uniforms: the swell, and the march's first step. */
export function flowUniforms(params: MapParams, mf: MapFrame) {
	return {
		frame: frameUniform(mf),
		swell: {
			heading: swellHeading(params.swellAzimuth),
			length: params.swellLength,
			breakDepth: breakDepth(params.swellHeight),
			speed: surfSpeed(params.swellHeight),
			drift: params.sedimentDrift,
		},
		reach: mf.texel * mf.resolution * LIGHT_REACH_SHARE,
	};
}

/** The light kernel's uniforms. */
export function lightUniforms(params: MapParams, mf: MapFrame) {
	return {
		frame: frameUniform(mf),
		sun: sunDirection(params.sunAzimuth, params.sunElevation),
		ceiling:
			Math.max(params.plateHeight, 0) +
			Math.max(params.lipHeight, 0) +
			Math.max(params.crownHeight, 0),
		reach: mf.texel * mf.resolution * LIGHT_REACH_SHARE,
		blur: Math.max(params.shadowBlur, 0),
	};
}

/** The files kernel's uniforms: the frame, and a file's disc radius. */
export function filesUniforms(params: MapParams, mf: MapFrame) {
	return {
		frame: frameUniform(mf),
		radius: Math.max(params.fileRadius, mf.texel),
	};
}

/** Chart units past a road's, parcel's or building's edge over which its reserve eases off. */
export const RESERVE_EASE = 1;
/** Chart units across a zone's edge over which its growth fades in. */
const ZONE_FEATHER = 2;

/**
 * The zoning kernel's uniforms: the frame, the reserve's ease and the
 * zones' feather, and how far a shape's quad reaches past its points to
 * hold them and every ring, with a texel to spare.
 */
export function zoningUniforms(mf: MapFrame) {
	const ease = Math.max(RESERVE_EASE, mf.texel);
	const feather = Math.max(ZONE_FEATHER, mf.texel);
	const ring = Math.max(
		...[HEDGE, FIELD_EDGE].map((r) => r.offset + Math.max(r.half, mf.texel))
	);
	return {
		frame: frameUniform(mf),
		ease: RESERVE_EASE,
		feather: ZONE_FEATHER,
		reach: Math.max(ease, feather / 2, ring) + mf.texel,
	};
}
