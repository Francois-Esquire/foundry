/**
 * The chart as textures: every map Islands samples, built on the GPU from a
 * `Chart` and `MapParams`, and rebuilt only when its inputs change.
 *
 * distance and islands come from one pass over the coast segments, and
 * coasts (each island's own distance, one layer per island) from one pass
 * per island; coverage from the distance; height from the distance and
 * coasts (its banks also from the chart's groups, `packBanks`), and with
 * it rings (the bank whose plate each sea texel stands on); flow (the
 * sea's surf) from the distance and height; light and shade (the sun at
 * the sea surface) from the height, by one pass; paint from islands,
 * coverage and distance; files from the chart's modules alone, a disc each;
 * zoning from the world plan alone (`setWorld`, zoning.ts): what its roads,
 * parcels and buildings reserve and what its zones grow; seabed, the open
 * sea's floor far past the frame, from the seascape, the distance map
 * (its distance from the coasts and the way out from them, run on past the
 * frame's edge) and the height map (where it starts at the frame's edge),
 * over its own larger, coarser square (map-uniforms.ts `seabedFrame`).
 * Formats that WebGPU cannot write as storage without an optional device
 * feature (rg16float, r8unorm, r16float, r32uint) are rendered by fullscreen
 * passes straight into the published texture, one mip level at a time;
 * flow, light, shade and paint are compute passes writing storage textures;
 * files and zoning are instanced draws, blended into their render
 * targets. A
 * build encodes every rebuilt map into one frame, one submit. Each map
 * keeps two textures and a rebuild writes the one not on show, so a map's
 * texture object changes exactly when that map rebuilds, and a rebuild
 * never pays for a fresh map texture (on Metal that costs the GPU more than
 * the kernels do). The height kernel's scratch (height-bake.ts) is the
 * exception: allocated per height rebuild and freed once it has run, so
 * a large chart's workspace is not kept resident between rebuilds.
 */
import {
	type Compute,
	compute,
	type Draw,
	draw,
	type Effect,
	effect,
	type Frame,
	frame,
	type Gpu,
	type ShaderSource,
	type StorageBuffer,
	sampler,
	storage,
	type Target,
	type Texture,
	texture,
} from "vgpu";
import type { Chart } from "../../../data/chart";
import { banksOf } from "../sea/banks";
import { wordsPerBank } from "../view/selection";
import type { WorldPlan, ZoneKind } from "../world/world";
import {
	type PackedZoning,
	packZoning,
	ZONE_GROWTH,
	ZONE_ORDER,
} from "../world/zoning";
import { type BakeLayout, bakeLayout } from "./bake-layout";
import {
	type BankBuffers,
	heightBindings,
	heightWorkspace,
	releaseWorkspace,
} from "./height-bake";
import {
	packBanks,
	packCoasts,
	packModules,
	packPieces,
	placeholderColors,
} from "./map-data";
import {
	changedParams,
	MAP_NAMES,
	MAP_OF_PARAM,
	MAP_PASSES,
	type MapName,
	type MapParams,
	type MapPass,
	type MapPassName,
	passesWithDependants,
} from "./map-params";
import {
	filesUniforms,
	flowUniforms,
	frameUniform,
	lightUniforms,
	type MapFrame,
	mipLevelCount,
	paintUniforms,
	SEABED_RESOLUTION,
	seabedFrame,
	seabedUniforms,
	zoningUniforms,
} from "./map-uniforms";

/** One prepared shader per map kernel. */
export interface MapShaders {
	coasts: ShaderSource;
	coverage: ShaderSource;
	distance: ShaderSource;
	/** One mip level from the level above, for distance and height. */
	downsample: ShaderSource;
	/** A disc per module, instanced. */
	files: ShaderSource;
	flow: ShaderSource;
	height: ShaderSource;
	light: ShaderSource;
	paint: ShaderSource;
	/** The open sea's floor past the frame. */
	seabed: ShaderSource;
	/** The world plan's zones, rings and reserves, instanced. */
	zoning: ShaderSource;
}

/**
 * Each kernel's file, relative to the islands folder. Exhaustive over
 * `MapShaders`, so headless tools load exactly the set the browser imports.
 */
export const MAP_SHADER_FILES: Record<keyof MapShaders, string> = {
	coasts: "shaders/maps/coasts.wgsl",
	coverage: "shaders/maps/coverage.wgsl",
	distance: "shaders/maps/distance.wgsl",
	downsample: "shaders/maps/downsample.wgsl",
	files: "shaders/maps/files.wgsl",
	flow: "shaders/maps/flow.wgsl",
	height: "shaders/maps/height.wgsl",
	light: "shaders/maps/light.wgsl",
	paint: "shaders/maps/paint.wgsl",
	seabed: "shaders/maps/seabed.wgsl",
	zoning: "shaders/maps/zoning.wgsl",
};

/**
 * Each map's texture format. distance and height carry a full mip chain;
 * coasts is an array, one layer per island.
 */
export const MAP_FORMATS = {
	distance: "rg16float",
	islands: "r32uint",
	coverage: "r8unorm",
	coasts: "r16float",
	// r the height; g and b what the terrain rebuilds the land from between
	// texels: the rim's distance inland and the floor at the coast; a how
	// far past the platform's edge the floor is (height.wgsl `Texel`).
	height: "rgba16float",
	// r the bank whose plate the floor stands on, its index in the global
	// order (banks.ts) + 1, 0 on land, the platform and the deep; g, b, a
	// every bank whose plate covers it, under what stands on it, a bit per
	// index, the first 48.
	rings: "rgba16uint",
	footprints: "rgba32uint",
	flow: "rgba16float",
	light: "rgba16float",
	// One channel used: rgba8unorm is the smallest format a compute pass
	// can write and the water can filter.
	shade: "rgba8unorm",
	paint: "rgba8unorm",
	// rgb each file's colour by kind, premultiplied; a its cover.
	files: "rgba8unorm",
	// world.ts `ZONING_CHANNELS`: r reserved, g trees, b shrubs, a open
	// ground. Filtered, so the reserve's soft edge reads smoothly.
	zoning: "rgba8unorm",
	// r the floor's height past the frame; g, b its normal, x and z; a how
	// far the open sea's floor has taken over (seabed.wgsl).
	seabed: "rgba16float",
} as const satisfies Record<MapName, GPUTextureFormat>;

const MIPPED: ReadonlySet<MapName> = new Set<MapName>(["distance", "height"]);
/** The maps compute passes write as storage; the rest are render targets. */
const WRITTEN_BY_COMPUTE: ReadonlySet<MapName> = new Set<MapName>([
	"flow",
	"light",
	"shade",
	"paint",
]);

export interface MapsReport {
	/**
	 * Main-thread milliseconds to bind and encode each rebuilt map (the first
	 * build at a resolution includes pipeline creation). The GPU runs the
	 * work afterwards; `settled` times the whole of it.
	 */
	readonly ms: Partial<Record<MapName, number>>;
	/** The maps this build rebuilt, in build order. */
	readonly rebuilt: readonly MapName[];
	/**
	 * Resolves once the GPU has finished every rebuilt map, with the wall
	 * milliseconds from the start of `build` to then. One total: the queue
	 * reports completions in batches, so no honest per-map split exists
	 * without timestamp queries.
	 */
	readonly settled: Promise<number>;
}

/**
 * A large chart's bank footprints, which selection-cache.ts resolves into
 * the highlight when the selection changes; small charts' rings map holds
 * every bank itself.
 */
export interface BakedSelection {
	readonly footprints: Texture;
	readonly wordsPerBank: number;
}

/** What the frame reads of the maps: their square and their textures. */
export interface MapSource {
	readonly frame: MapFrame;
	/** The seabed map's square, larger and coarser than `frame`, centred on it. */
	readonly seabed: MapFrame;
	/** Null where the rings map holds every bank (`BakeLayout.footprints` off). */
	readonly selection: BakedSelection | null;
	readonly textures: Readonly<Record<MapName, Texture>>;
}

export interface Maps extends MapSource {
	/**
	 * Builds or rebuilds only the maps whose inputs or parameters changed,
	 * encoding all of them into one frame.
	 *
	 * Without `into`, the build opens and submits a frame of its own, so it
	 * must not run inside another frame's callback (a `frame(gpu, cb)` or a
	 * `frameLoop` tick): vgpu throws `VGPU-FRAME-REENTRANT` for a nested
	 * frame. From inside a frame, pass that frame as `into`: the build
	 * encodes after whatever the frame already holds and submits with it.
	 * Passes encoded before the build still see the old textures, passes
	 * after it the new ones (`textures` is updated on return). The frame must
	 * be submitted before the current task ends, as `frame(gpu, cb)` and
	 * `frameLoop` do; after a change of resolution the replaced textures are
	 * freed once it has run. A canceled frame leaves the new textures
	 * unwritten.
	 */
	build: (chart: Chart, params: MapParams, into?: Frame) => MapsReport;
	dispose: () => void;
	/** The frame of the last build. Throws before the first build. */
	readonly frame: MapFrame;
	/**
	 * The world plan the zoning map is baked from. The next build rebuilds
	 * the zoning map alone; null leaves it empty: nothing reserved, nothing
	 * grown.
	 */
	setWorld: (plan: WorldPlan | null) => void;
	/**
	 * One texture per map, replaced (new object) only when its map
	 * rebuilds; the replaced texture is overwritten by the next rebuild (or
	 * destroyed with a new resolution), so rebind after every
	 * build that rebuilt something. Throws before the first build.
	 */
	readonly textures: Readonly<Record<MapName, Texture>>;
}

const WORKGROUP = 8;

type PassOptions = Parameters<Target["renderPassDescriptor"]>[0];

/**
 * One mip level (and array layer) of a published texture as a render
 * target (with the second texture of an MRT pass alongside), so a pass
 * writes the map in place: no working copy, no copy commands, and the
 * whole build fits one frame.
 */
export function levelTarget(
	textures: readonly [Texture, ...Texture[]],
	level: number,
	layer = 0
): Target {
	const [first] = textures;
	// Maps are square.
	const side = first.size[0] / 2 ** level;
	const size = [side, side] as const;
	return {
		gpu: first,
		size,
		texelSize: [1 / side, 1 / side],
		color: first,
		colors: textures,
		format: first.format,
		sampleCount: 1,
		clearColor: [0, 0, 0, 0],
		resourceIdentity: first.resourceIdentity,
		resize() {
			throw new Error("A map level target has a fixed size");
		},
		onDestroy: (cb) =>
			first.onDestroy(() => cb(levelTarget(textures, level, layer))),
		renderPassDescriptor: (opts?: PassOptions) => ({
			colorAttachments: textures.map((t) => ({
				view: t.createView({
					dimension: "2d",
					baseMipLevel: level,
					mipLevelCount: 1,
					baseArrayLayer: layer,
					arrayLayerCount: 1,
				}),
				loadOp: opts?.preserve ? "load" : "clear",
				storeOp: "store",
			})),
		}),
	};
}

/** The passes for one resolution, rebound to fresh textures every build. */
interface Passes {
	/** One pass per layer, its island set before each. */
	readonly coasts: Effect;
	readonly coverage: Effect;
	readonly distance: Effect;
	/** One per mip level from 1 on, for distance and height. */
	readonly downsample: Readonly<Record<"distance" | "height", Effect[]>>;
	/** One instanced disc per module. */
	readonly files: Draw;
	readonly flow: Compute;
	readonly height: Draw;
	/** What the passes were made for: its resolution and specializations. */
	readonly key: string;
	readonly light: Compute;
	readonly paint: Compute;
	readonly seabed: Effect;
	/** The world plan's ground, in draw order (zoning.wgsl). */
	readonly zoning: ZoningDraws;
}

/** The zoning map's draws: a zone kind's each, the rings, the reserves. */
interface ZoningDraws {
	readonly reserves: Draw;
	readonly rings: Draw;
	readonly roads: Draw;
	readonly zones: Readonly<Record<ZoneKind, Draw>>;
}

/** Passes are remade only when the resolution or a specialization changes. */
const passesKey = (layout: BakeLayout): string =>
	`${layout.frame.resolution}:${layout.scalable}:${layout.footprints}`;

/** Each map's texture: shape, format and usage, as a layout sizes it. */
export function mapTextureDescriptor(name: MapName, layout: BakeLayout) {
	const { resolution } = layout.frame;
	const usage = (writer: "render_attachment" | "storage_binding") =>
		[writer, "texture_binding", "copy_src"] as const;
	if (name === "coasts") {
		const side = layout.coastResolution * layout.coastColumns;
		return {
			kind: "2d-array",
			size: [side, side],
			layers: layout.coastLayers,
			format: MAP_FORMATS.coasts,
			mipLevelCount: 1,
			usage: usage("render_attachment"),
		} as const;
	}
	if (name === "seabed") {
		return {
			kind: "2d",
			size: [SEABED_RESOLUTION, SEABED_RESOLUTION],
			format: MAP_FORMATS.seabed,
			mipLevelCount: 1,
			usage: usage("render_attachment"),
		} as const;
	}
	if (name === "footprints") {
		// A 1×1 stand-in where the rings map holds every bank.
		const side = layout.footprints ? resolution : 1;
		return {
			kind: "2d-array",
			size: [side, side],
			layers: layout.footprints ? layout.footprintPages : 1,
			format: MAP_FORMATS.footprints,
			mipLevelCount: 1,
			usage: usage("storage_binding"),
		} as const;
	}
	return {
		kind: "2d",
		size: [resolution, resolution],
		format: MAP_FORMATS[name],
		mipLevelCount: MIPPED.has(name) ? mipLevelCount(resolution) : 1,
		usage: usage(
			WRITTEN_BY_COMPUTE.has(name) ? "storage_binding" : "render_attachment"
		),
	} as const;
}

/** The textures after a build: the rebuilt maps' new ones, the rest kept. */
function mergeTextures(
	before: Readonly<Record<MapName, Texture>> | undefined,
	rebuilt: Partial<Record<MapName, Texture>>
): Record<MapName, Texture> {
	const pick = (name: MapName): Texture => {
		const chosen = rebuilt[name] ?? before?.[name];
		if (!chosen) {
			throw new Error(`Map ${name} has never been built`);
		}
		return chosen;
	};
	return {
		distance: pick("distance"),
		islands: pick("islands"),
		coverage: pick("coverage"),
		coasts: pick("coasts"),
		height: pick("height"),
		rings: pick("rings"),
		footprints: pick("footprints"),
		flow: pick("flow"),
		light: pick("light"),
		shade: pick("shade"),
		paint: pick("paint"),
		files: pick("files"),
		zoning: pick("zoning"),
		seabed: pick("seabed"),
	};
}

/**
 * A zone over the map by its cover, which is its alpha: g and b come
 * premultiplied from the fragment, and a from the blend constant, the
 * kind's open ground (zoning.wgsl `fs_zone`).
 */
const ZONE_BLEND = {
	color: { src: "one", dst: "one-minus-src-alpha" },
	alpha: { src: "constant", dst: "one-minus-src-alpha" },
} as const;
/** The larger of the ring's density and the map's, channel by channel. */
const RING_BLEND = {
	color: { src: "one", dst: "one", op: "max" },
	alpha: { src: "one", dst: "one", op: "max" },
} as const;
/**
 * A reserve over the map by its cover: r gains it, and g, b and a lose
 * the same share of what they hold.
 */
const RESERVE_BLEND = {
	color: { src: "one", dst: "one-minus-src-alpha" },
	alpha: { src: "zero", dst: "one-minus-src-alpha" },
} as const;

function createZoningDraws(gpu: Gpu, shader: ShaderSource): ZoningDraws {
	const polygons = (
		label: string,
		fragment: string,
		blend: typeof ZONE_BLEND | typeof RING_BLEND | typeof RESERVE_BLEND,
		blendConstant?: readonly [number, number, number, number]
	) =>
		draw(gpu, {
			shader,
			label: `islands-zoning-${label}`,
			entry: { vertex: "vs_polygon", fragment },
			vertices: 6,
			blend,
			blendConstant,
		});
	const zones = Object.fromEntries(
		ZONE_ORDER.map((kind) => {
			const { open } = ZONE_GROWTH[kind];
			return [
				kind,
				polygons(kind, "fs_zone", ZONE_BLEND, [open, open, open, open]),
			];
		})
	) as Record<ZoneKind, Draw>;
	return {
		zones,
		rings: polygons("rings", "fs_ring", RING_BLEND),
		reserves: polygons("reserves", "fs_reserve", RESERVE_BLEND),
		roads: draw(gpu, {
			shader,
			label: "islands-zoning-roads",
			entry: { vertex: "vs_road", fragment: "fs_road" },
			vertices: 6,
			blend: RESERVE_BLEND,
		}),
	};
}

export function createMaps(gpu: Gpu, shaders: MapShaders): Maps {
	let passes: Passes | undefined;
	let published: Record<MapName, Texture> | undefined;
	/** The last successful build's inputs and layout. */
	let last: { chart: Chart; layout: BakeLayout; params: MapParams } | undefined;
	let coastBuffers:
		| { chart: Chart; coasts: StorageBuffer; segments: StorageBuffer }
		| undefined;
	let pieceBuffers:
		| { islands: StorageBuffer; pieces: StorageBuffer }
		| undefined;
	let colorBuffer: StorageBuffer | undefined;
	let moduleBuffer: StorageBuffer | undefined;
	/** The world plan's packed ground, and whether the zoning map has drawn it yet. */
	let world: PackedZoning | null = null;
	let worldBuffers:
		| {
				points: StorageBuffer;
				polygons: StorageBuffer;
				segments: StorageBuffer;
		  }
		| undefined;
	let worldDirty = false;
	let bankBuffers: BankBuffers | undefined;
	/** Each map's texture not on show, at the current resolution. */
	const spares = new Map<MapName, Texture>();
	/** Replaced textures a caller's frame may still use, freed once it ran. */
	const retired = new Set<Texture>();
	const linear = sampler(gpu, { magFilter: "linear", minFilter: "linear" });

	/** A buffer at least `bytes` long, reusing `current` while it fits. */
	const fit = (current: StorageBuffer | undefined, bytes: number) => {
		if (current && current.size >= bytes) {
			return current;
		}
		return storage(
			gpu,
			Math.max(256, Math.ceil((bytes * 1.5) / 4) * 4),
			"read"
		);
	};

	/** `data` in a buffer at least its size, reusing `current` while it fits. */
	const upload = (
		current: StorageBuffer | undefined,
		data: ArrayBuffer | Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>
	) => {
		const buffer = fit(current, data.byteLength);
		buffer.write(data);
		return buffer;
	};

	/**
	 * The chart's coast segments, uploaded once per chart: the distance and
	 * coasts kernels both read them.
	 */
	const uploadCoasts = (chart: Chart) => {
		if (coastBuffers?.chart === chart) {
			return coastBuffers;
		}
		const packed = packCoasts(chart);
		coastBuffers = {
			chart,
			coasts: upload(coastBuffers?.coasts, packed.coasts),
			segments: upload(coastBuffers?.segments, packed.segments),
		};
		return coastBuffers;
	};

	const createPasses = (layout: BakeLayout): Passes => {
		const levels = mipLevelCount(layout.frame.resolution) - 1;
		const downsample = (label: string) =>
			Array.from({ length: levels }, (_, i) =>
				effect(gpu, shaders.downsample, { label: `${label}-${i + 1}` })
			);
		return {
			key: passesKey(layout),
			distance: effect(gpu, shaders.distance, { label: "islands-distance" }),
			coasts: effect(gpu, shaders.coasts, { label: "islands-coasts" }),
			coverage: effect(gpu, shaders.coverage, { label: "islands-coverage" }),
			height: draw(gpu, {
				shader: shaders.height,
				label: "islands-height",
				constants: {
					SCALABLE_HEIGHT: layout.scalable,
					WRITE_FOOTPRINTS: layout.footprints,
				},
				set: { linear },
			}),
			downsample: {
				distance: downsample("islands-distance-mip"),
				height: downsample("islands-height-mip"),
			},
			flow: compute(gpu, shaders.flow, {
				label: "islands-flow",
				set: { linear },
			}),
			light: compute(gpu, shaders.light, {
				label: "islands-light",
				set: { linear },
			}),
			paint: compute(gpu, shaders.paint, { label: "islands-paint" }),
			seabed: effect(gpu, shaders.seabed, {
				label: "islands-seabed",
				set: { linear },
			}),
			files: draw(gpu, {
				shader: shaders.files,
				label: "islands-files",
				vertices: 6,
				blend: "premultiplied",
			}),
			zoning: createZoningDraws(gpu, shaders.zoning),
		};
	};

	const disposePasses = (p: Passes) => {
		for (const pass of [
			p.distance,
			p.coasts,
			p.coverage,
			p.height,
			p.seabed,
			...p.downsample.distance,
			...p.downsample.height,
		]) {
			pass.dispose();
		}
		p.files.dispose();
		for (const d of [
			...Object.values(p.zoning.zones),
			p.zoning.rings,
			p.zoning.reserves,
			p.zoning.roads,
		]) {
			d.dispose();
		}
		p.flow.dispose();
		p.light.dispose();
		p.paint.dispose();
	};

	/** Each level of a mipped map from the one above, in place. */
	const encodeMips = (f: Frame, dest: Texture, chain: readonly Effect[]) => {
		for (const [i, pass] of chain.entries()) {
			pass.set({
				source: dest.createView({ baseMipLevel: i, mipLevelCount: 1 }),
			});
			f.pass(levelTarget([dest], i + 1), pass);
		}
	};

	/** One build's inputs: `maps` are the textures as they stand after it. */
	interface Build {
		readonly chart: Chart;
		readonly f: Frame;
		readonly layout: BakeLayout;
		readonly maps: Record<MapName, Texture>;
		readonly p: Passes;
		readonly params: MapParams;
	}

	/** Compute passes' workgroups across a map. */
	const groupsOf = (mf: MapFrame) => Math.ceil(mf.resolution / WORKGROUP);

	/**
	 * The world plan's ground into the zoning map, in one pass: each zone
	 * kind's growth in `ZONE_ORDER`, then the rings, then what the parcels,
	 * buildings and roads reserve, which clears the growth under them.
	 */
	const encodeZoning = ({ f, layout, maps, p }: Build) => {
		worldDirty = false;
		const packed = world;
		if (!packed) {
			// The pass clears the map: nothing reserved, nothing grown.
			f.pass(levelTarget([maps.zoning], 0), () => undefined);
			return;
		}
		const buffers = {
			points: upload(worldBuffers?.points, packed.points),
			polygons: upload(worldBuffers?.polygons, packed.polygons),
			segments: upload(worldBuffers?.segments, packed.segments),
		};
		worldBuffers = buffers;
		const set = { params: zoningUniforms(layout.frame), ...buffers };
		f.pass(levelTarget([maps.zoning], 0), (pass) => {
			const polygons = (d: Draw, run: { count: number; first: number }) => {
				if (run.count > 0) {
					d.set(set);
					pass.draw(d, { instances: run.count, firstInstance: run.first });
				}
			};
			for (const kind of ZONE_ORDER) {
				polygons(p.zoning.zones[kind], packed.zones[kind]);
			}
			polygons(p.zoning.rings, packed.rings);
			polygons(p.zoning.reserves, packed.reserves);
			if (packed.segmentCount > 0) {
				p.zoning.roads.set(set);
				pass.draw(p.zoning.roads, { instances: packed.segmentCount });
			}
		});
	};

	/** Binds each map's kernel to its inputs and encodes it. */
	const encoders: Record<MapPassName, (build: Build) => void> = {
		distance: ({ chart, f, layout, maps, p }) => {
			const { coasts, segments } = uploadCoasts(chart);
			p.distance.set({
				params: {
					frame: frameUniform(layout.frame),
					islandCount: chart.islands.length,
				},
				coasts,
				segments,
			});
			f.pass(levelTarget([maps.distance, maps.islands], 0), p.distance);
			encodeMips(f, maps.distance, p.downsample.distance);
		},
		coverage: ({ f, layout, maps, p, params }) => {
			p.coverage.set({
				params: { frame: frameUniform(layout.frame), feather: params.feather },
				distance: maps.distance,
			});
			f.pass(levelTarget([maps.coverage], 0), p.coverage);
		},
		coasts: ({ chart, f, layout, maps, p }) => {
			const { segments } = uploadCoasts(chart);
			const packed = packPieces(chart);
			const buffers = {
				islands: upload(pieceBuffers?.islands, packed.islands),
				pieces: upload(pieceBuffers?.pieces, packed.pieces),
			};
			pieceBuffers = buffers;
			const { coastColumns: columns, coastResolution: cellSide } = layout;
			const mf = layout.frame;
			const coastsFrame = frameUniform({
				...mf,
				resolution: cellSide,
				texel: (mf.texel * mf.resolution) / cellSide,
			});
			const cellsPerLayer = columns * columns;
			// One pass a cell: each captures its own island when encoded.
			for (let island = 0; island < chart.islands.length; island += 1) {
				const cell = island % cellsPerLayer;
				const offset = [
					(cell % columns) * cellSide,
					Math.floor(cell / columns) * cellSide,
				] as const;
				p.coasts.set({
					params: { frame: coastsFrame, island, offset },
					islands: buffers.islands,
					pieces: buffers.pieces,
					segments,
				});
				f.pass(
					{
						target: levelTarget(
							[maps.coasts],
							0,
							Math.floor(island / cellsPerLayer)
						),
						clear: false,
						viewport: {
							x: offset[0],
							y: offset[1],
							width: cellSide,
							height: cellSide,
						},
					},
					p.coasts
				);
			}
		},
		height: ({ chart, f, layout, maps, p, params }) => {
			const mf = layout.frame;
			const packed = packBanks(chart);
			bankBuffers = {
				islands: upload(bankBuffers?.islands, packed.islands),
				banks: upload(bankBuffers?.banks, packed.banks),
				members: upload(bankBuffers?.members, packed.members),
			};
			const workspace = heightWorkspace(gpu, chart, mf.resolution);
			releaseWorkspace(f, workspace);
			const bindings = heightBindings(params, mf, packed, bankBuffers, maps);
			for (
				let rowStart = 0;
				rowStart < mf.resolution;
				rowStart += workspace.rows
			) {
				p.height.set({
					...bindings,
					params: {
						...bindings.params,
						coastColumns: layout.coastColumns,
						rowStart,
					},
					states: workspace.states,
					masks: workspace.masks,
					footprint: maps.footprints,
				});
				f.pass(
					{
						target: levelTarget([maps.height, maps.rings], 0),
						clear: false,
						viewport: {
							x: 0,
							y: rowStart,
							width: mf.resolution,
							height: Math.min(workspace.rows, mf.resolution - rowStart),
						},
					},
					p.height
				);
			}
			encodeMips(f, maps.height, p.downsample.height);
		},
		flow: ({ f, layout, maps, p, params }) => {
			p.flow.set({
				params: flowUniforms(params, layout.frame),
				distance: maps.distance,
				height: maps.height,
				flow: maps.flow,
			});
			const groups = groupsOf(layout.frame);
			f.computePass((c) => c.dispatch(p.flow, groups, groups));
		},
		light: ({ f, layout, maps, p, params }) => {
			p.light.set({
				params: lightUniforms(params, layout.frame),
				height: maps.height,
				light: maps.light,
				shade: maps.shade,
			});
			const groups = groupsOf(layout.frame);
			f.computePass((c) => c.dispatch(p.light, groups, groups));
		},
		paint: ({ chart, f, layout, maps, p, params }) => {
			const colors = placeholderColors(chart, params.palette);
			colorBuffer = fit(colorBuffer, colors.byteLength);
			colorBuffer.write(colors);
			p.paint.set({
				params: paintUniforms(params, layout.frame, chart),
				islands: maps.islands,
				coverage: maps.coverage,
				distance: maps.distance,
				colors: colorBuffer,
				paint: maps.paint,
				height: maps.height,
			});
			const groups = groupsOf(layout.frame);
			f.computePass((c) => c.dispatch(p.paint, groups, groups));
		},
		files: ({ chart, f, layout, maps, p, params }) => {
			moduleBuffer = upload(moduleBuffer, packModules(chart));
			p.files.set({
				params: filesUniforms(params, layout.frame),
				files: moduleBuffer,
			});
			// The pass clears the map; a chart without files draws nothing on it.
			f.pass(levelTarget([maps.files], 0), (pass) => {
				if (chart.modules.length > 0) {
					pass.draw(p.files, { instances: chart.modules.length });
				}
			});
		},
		zoning: encodeZoning,
		seabed: ({ chart, f, layout, maps, p, params }) => {
			p.seabed.set({
				params: seabedUniforms(params, layout.frame, banksOf(chart).levels),
				distance: maps.distance,
				height: maps.height,
			});
			f.pass(levelTarget([maps.seabed], 0), p.seabed);
		},
	};

	const dirtyPasses = (chart: Chart, params: MapParams): readonly MapPass[] => {
		if (!(last && published) || chart !== last.chart) {
			return MAP_PASSES;
		}
		const changed = changedParams(last.params, params).flatMap(
			(key) => MAP_OF_PARAM[key]
		);
		return passesWithDependants(worldDirty ? [...changed, "zoning"] : changed);
	};

	const freeRetired = () => {
		for (const old of retired) {
			old.destroy();
		}
		retired.clear();
	};

	const passesFor = (layout: BakeLayout): Passes => {
		if (passes?.key !== passesKey(layout)) {
			if (passes) {
				disposePasses(passes);
			}
			passes = createPasses(layout);
		}
		return passes;
	};

	/**
	 * A texture to write for each rebuilt map: its spare while it still has
	 * the layout's shape, or a new one.
	 */
	const take = (rebuilt: readonly MapName[], layout: BakeLayout) => {
		const next: Partial<Record<MapName, Texture>> = {};
		for (const name of rebuilt) {
			const wanted = mapTextureDescriptor(name, layout);
			let spare = spares.get(name);
			spares.delete(name);
			if (
				spare &&
				(spare.size[0] !== wanted.size[0] ||
					spare.layers !== (wanted.kind === "2d-array" ? wanted.layers : 1))
			) {
				spare.destroy();
				spare = undefined;
			}
			next[name] =
				spare ?? texture(gpu, { ...wanted, label: `islands-${name}` });
		}
		return next;
	};

	/**
	 * After a build: each replaced texture becomes its map's spare, or at a
	 * new resolution is freed, once the frame that may still use it has run.
	 * Resolves with the wall milliseconds from `begun` to the GPU finishing.
	 */
	const release = (
		rebuilt: readonly MapName[],
		resized: boolean,
		into: Frame | undefined,
		begun: number
	): Promise<number> => {
		const replaced: Texture[] = [];
		for (const name of rebuilt) {
			const old = published?.[name];
			if (old && resized) {
				replaced.push(old);
			} else if (old) {
				spares.set(name, old);
			}
		}
		if (!into) {
			for (const old of replaced) {
				old.destroy();
			}
			return gpu.gpu.queue
				.onSubmittedWorkDone()
				.then(() => performance.now() - begun);
		}
		// The caller's frame may draw with the replaced textures and submits
		// only when its callback returns: free them, and time the work, once
		// that frame has run. `done` is read a tick later because submitting
		// replaces it: during the callback it is a placeholder, already
		// resolved.
		for (const old of replaced) {
			retired.add(old);
		}
		return Promise.resolve()
			.then(() => into.done)
			.then(() => {
				for (const old of replaced) {
					if (retired.delete(old)) {
						old.destroy();
					}
				}
				return performance.now() - begun;
			});
	};

	return {
		get selection() {
			return last && published && last.layout.footprints
				? {
						footprints: published.footprints,
						wordsPerBank: wordsPerBank(last.chart.islands.length),
					}
				: null;
		},
		get frame() {
			if (!last) {
				throw new Error("Maps.frame is read before the first build()");
			}
			return last.layout.frame;
		},
		get seabed() {
			if (!last) {
				throw new Error("Maps.seabed is read before the first build()");
			}
			return seabedFrame(last.layout.frame, last.params);
		},
		get textures() {
			if (!published) {
				throw new Error("Maps.textures is read before the first build()");
			}
			return published;
		},
		setWorld(plan) {
			world = plan ? packZoning(plan) : null;
			worldDirty = true;
		},
		build(chart, params, into) {
			const rebuilding = dirtyPasses(chart, params);
			const rebuilt = rebuilding.flatMap((pass) => [...pass.outputs]);
			if (rebuilt.length === 0) {
				return { rebuilt, ms: {}, settled: Promise.resolve(0) };
			}
			const layout = bakeLayout(
				chart,
				params,
				gpu.gpu.limits.maxTextureDimension2D,
				gpu.gpu.limits.maxTextureArrayLayers
			);
			const p = passesFor(layout);
			const resized = last?.layout.frame.resolution !== layout.frame.resolution;
			const begun = performance.now();
			const next = take(rebuilt, layout);
			const maps = mergeTextures(published, next);
			const ms: Partial<Record<MapName, number>> = {};
			const encode = (f: Frame) => {
				const build: Build = { chart, f, layout, maps, p, params };
				for (const pass of rebuilding) {
					const start = performance.now();
					encoders[pass.name](build);
					ms[pass.name] = performance.now() - start;
					// Companion maps are written by the same pass, with no separate encode.
					for (const output of pass.outputs) {
						ms[output] ??= 0;
					}
				}
			};
			try {
				if (into) {
					encode(into);
				} else {
					frame(gpu, encode);
				}
			} catch (error) {
				// Nothing was submitted: the textures taken stay spare.
				for (const name of rebuilt) {
					const taken = next[name];
					if (taken) {
						spares.set(name, taken);
					}
				}
				throw error;
			}
			const settled = release(rebuilt, resized, into, begun);
			published = maps;
			last = { chart, layout, params: { ...params } };
			return { rebuilt, ms, settled };
		},
		dispose() {
			if (passes) {
				disposePasses(passes);
				passes = undefined;
			}
			for (const name of MAP_NAMES) {
				published?.[name].destroy();
			}
			for (const spare of spares.values()) {
				spare.destroy();
			}
			spares.clear();
			freeRetired();
			coastBuffers = undefined;
			pieceBuffers = undefined;
			colorBuffer = undefined;
			moduleBuffer = undefined;
			worldBuffers = undefined;
			bankBuffers = undefined;
			published = undefined;
			last = undefined;
		},
	};
}
