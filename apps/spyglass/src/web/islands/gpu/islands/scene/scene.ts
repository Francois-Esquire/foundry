/**
 * The frame: the terrain, the props on the shallows (debris.ts) and the
 * world's drawn layers on the tops (WORLD.md layers 3 to 5, `WORLD_LAYERS`)
 * into the film, the water composited from the film into the post's
 * linear frame, then the post (post.ts: bloom, vignette, encoding,
 * anti-aliasing) onto the output. Shared by the browser and the headless
 * tools, which hand in their own prepared shaders.
 *
 * The film is a single-sample offscreen target, linear `rgba16float` colour
 * with a `depth32float` depth, reversed-Z (cleared to 0, terrain drawn with
 * `compare: "greater"`). Single-sample because the composite reads the depth
 * as a texture, which a multisampled target cannot give. The film may be
 * smaller than the output (render scale); the composite runs at the
 * output's size and upsamples it.
 */
import {
	type Draw,
	draw,
	type Effect,
	effect,
	type Frame,
	type Geometry,
	type Gpu,
	geometry,
	type ShaderSource,
	type StorageBuffer,
	sampler,
	storage,
	type Target,
	type Texture,
	type TimerSpan,
	target,
} from "vgpu";
import { type ClipLayout, clipLayout, levelIndices } from "../land/clipmap";
import { createDebris, DEBRIS_MAPS, type DebrisShaders } from "../land/debris";
import { MAP_NAMES, type MapName } from "../maps/map-params";
import type { MapSource } from "../maps/maps";
import { createPost, type PostShaders } from "../post/post";
import type { View } from "../view/camera";
import {
	createSelectionCache,
	type SelectionShaders,
} from "../view/selection-cache";
import { createTown, type TownShaders } from "../world/town-draw";
import type { WorldLayer, WorldPlan } from "../world/world";
import { createFoliage, type FoliageShaders } from "../world/world-foliage";
import { createSurfaces } from "../world/world-surfaces";
import {
	debrisLightOf,
	postLookOf,
	terrainUniforms,
	waterUniforms,
} from "./frame-uniforms";
import type { Look } from "./look";

export interface IslandsShaders
	extends DebrisShaders,
		FoliageShaders,
		PostShaders,
		SelectionShaders,
		TownShaders {
	surfaces: ShaderSource;
	terrain: ShaderSource;
	water: ShaderSource;
}

/**
 * Each shader's file, relative to the islands folder. Exhaustive over
 * `IslandsShaders`, so the headless tools load exactly the set the browser
 * imports.
 */
export const SHADER_FILES: Record<keyof IslandsShaders, string> = {
	debrisPlace: "shaders/land/debris/place.wgsl",
	selectionPrepare: "shaders/view/selection-prepare.wgsl",
	selectionResolve: "shaders/view/selection-resolve.wgsl",
	debrisProps: "shaders/land/debris/props.wgsl",
	foliage: "shaders/world/foliage.wgsl",
	foliageScatter: "shaders/world/foliage-scatter.wgsl",
	postAntialias: "shaders/post/antialias.wgsl",
	postBloom: "shaders/post/bloom.wgsl",
	postFinish: "shaders/post/finish.wgsl",
	surfaces: "shaders/world/surfaces.wgsl",
	terrain: "shaders/land/terrain.wgsl",
	town: "shaders/world/town.wgsl",
	townFloors: "shaders/world/town-floors.wgsl",
	water: "shaders/scene/water.wgsl",
};

/** GPU spans to time the passes with, where the adapter has them. */
export interface SceneTimers {
	terrain?: TimerSpan;
	water?: TimerSpan;
}

export const FILM_FORMAT = "rgba16float";
const FILM_DEPTH = "depth32float";

/** The film's size for an output and a render scale, at least a pixel. */
export function filmSize(
	output: readonly [number, number],
	scale: number
): [number, number] {
	return [
		Math.max(1, Math.round(output[0] * scale)),
		Math.max(1, Math.round(output[1] * scale)),
	];
}

export interface Scene {
	/** The last frame's clipmap layout, for the readouts and tests. */
	readonly clip: ClipLayout | null;
	compile: (output: Target) => Promise<void>;
	dispose: () => void;
	/** The film: the terrain's colour and depth, before the water. */
	readonly film: Target;
	/** Draws a frame into `output`; encodes into `frame`, the caller submits. */
	render: (
		frame: Frame,
		output: Target,
		view: View,
		maps: MapSource,
		look: Look,
		timers?: SceneTimers
	) => void;
	/** The islands view's colours, one linear RGBA per island in chart order. */
	setIslandColors: (colors: Float32Array<ArrayBuffer>) => void;
	/**
	 * What the water highlights: the chosen and the hovered as pick.wgsl
	 * keeps them, and each bank's islands (selection.ts `memberMasks`).
	 */
	setSelection: (
		selection: StorageBuffer,
		members: Uint32Array<ArrayBuffer>
	) => void;
	/**
	 * The world plan (world.ts), handed to every drawn layer, which draw it
	 * on the tops in the shaded view. Its zoning is the maps'
	 * (`Maps.setWorld`).
	 */
	setWorld: (plan: WorldPlan) => void;
}

/**
 * Makes one of the world's drawn layers on the scene's device, with the
 * scene's shaders and its linear sampler.
 */
export type WorldLayerFactory = (
	gpu: Gpu,
	shaders: IslandsShaders,
	linear: GPUSampler
) => WorldLayer;

/**
 * The world's drawn layers in draw order (WORLD.md): the surfaces first,
 * on the terrain, then the structures, then the foliage.
 */
export const WORLD_LAYERS: readonly WorldLayerFactory[] = [
	(gpu, shaders, linear) => createSurfaces(gpu, shaders.surfaces, linear),
	createTown,
	createFoliage,
];

const sameTextures = (
	a: Readonly<Record<MapName, Texture>> | null,
	b: Readonly<Record<MapName, Texture>>,
	names: readonly MapName[] = MAP_NAMES
) => a !== null && (a === b || names.every((name) => a[name] === b[name]));

export function createScene(
	gpu: Gpu,
	shaders: IslandsShaders,
	layers: readonly WorldLayerFactory[] = WORLD_LAYERS
): Scene {
	const film = target(gpu, {
		size: [1, 1],
		format: FILM_FORMAT,
		depth: FILM_DEPTH,
		label: "islands-film",
	});
	// Clamp to edge (WebGPU's default): past the grid's edge the terrain
	// reads the edge texel's paint and light.
	const linear = sampler(gpu, { minFilter: "linear", magFilter: "linear" });
	const meshOf = (isRing: boolean): Geometry =>
		geometry(gpu, {
			buffers: [],
			indices: levelIndices(isRing),
			topology: "triangle-list",
			label: isRing ? "islands-clip-ring" : "islands-clip-square",
		});
	const meshes = [meshOf(false), meshOf(true)] as const;
	const terrainDraw = (mesh: Geometry, label: string): Draw =>
		draw(gpu, {
			shader: shaders.terrain,
			geometry: mesh,
			label,
			cull: "none",
			depth: { compare: "greater" },
		});
	const square = terrainDraw(meshes[0], "islands-terrain-square");
	const ring = terrainDraw(meshes[1], "islands-terrain-ring");
	const terrain = [square, ring] as const;
	const water: Effect = effect(gpu, shaders.water, {
		label: "islands-water",
		set: { film, filmDepth: film, filmSampler: linear, mapSampler: linear },
	});
	const debris = createDebris(gpu, shaders, linear);
	const world = layers.map((make) => make(gpu, shaders, linear));
	const post = createPost(gpu, shaders, linear);
	// The textures and densities the props were last placed on.
	let placedOn: Readonly<Record<MapName, Texture>> | null = null;
	let placedWith = "";
	let islandColors: StorageBuffer = storage(gpu, 16, "read");
	const bindColors = () => {
		for (const d of terrain) {
			d.set({ islandColors });
		}
	};
	bindColors();
	for (const d of terrain) {
		d.set({ mapSampler: linear });
	}

	let bound: Readonly<Record<MapName, Texture>> | null = null;
	let clip: ClipLayout | null = null;
	// Nothing chosen until a picker hands over its selection.
	let members: StorageBuffer = storage(gpu, 8, "read");
	let selectionBuffer = storage(gpu, 16, "read");
	water.set({ selection: selectionBuffer, members });
	let largeWater: Draw | undefined;
	let selectionCache: ReturnType<typeof createSelectionCache> | undefined;

	const bindMaps = (textures: Readonly<Record<MapName, Texture>>) => {
		if (sameTextures(bound, textures)) {
			return;
		}
		bound = textures;
		const {
			distance,
			islands,
			coverage,
			height,
			rings,
			flow,
			light,
			shade,
			paint,
			files,
			zoning,
		} = textures;
		for (const d of terrain) {
			d.set({
				distance,
				islands,
				coverage,
				height,
				rings,
				flow,
				light,
				shade,
				paint,
				files,
				zoning,
			});
		}
		water.set({ height, light, shade, distance, flow, paint, islands, rings });
	};

	return {
		get clip() {
			return clip;
		},
		film,
		async compile(output) {
			await Promise.all([
				square.compile(film),
				ring.compile(film),
				water.compile(post.frame),
				debris.compile(film),
				...world.map((layer) => layer.compile(film)),
				post.compile(output),
			]);
		},
		setWorld(plan) {
			for (const layer of world) {
				layer.set(plan);
			}
		},
		setIslandColors(colors) {
			// A chart's island count is fixed, so this allocates once per chart;
			// a palette change rewrites the same buffer.
			if (colors.byteLength !== islandColors.size) {
				islandColors = storage(gpu, Math.max(colors.byteLength, 16), "read");
				bindColors();
			}
			islandColors.write(colors);
		},
		setSelection(selection, masks) {
			if (masks.byteLength !== members.size) {
				members = storage(gpu, masks.byteLength, "read");
			}
			members.write(masks);
			selectionBuffer = selection;
			water.set({ selection, members });
			largeWater?.set({ selection, members });
		},
		render(frame, output, view, maps, look, timers = {}) {
			const size = filmSize(output.size, look.renderScale);
			if (size[0] !== film.size[0] || size[1] !== film.size[1]) {
				film.resize(size);
			}
			bindMaps(maps.textures);
			let activeWater: Effect | Draw = water;
			if (maps.selection) {
				if (!largeWater) {
					largeWater = draw(gpu, {
						shader: shaders.water,
						label: "islands-water-large",
						constants: { SCALABLE_SELECTION: true },
						set: {
							film,
							filmDepth: film,
							filmSampler: linear,
							mapSampler: linear,
							selection: selectionBuffer,
							members,
						},
					});
				}
				selectionCache ??= createSelectionCache(gpu, shaders);
				const cached = selectionCache.encode(
					frame,
					maps,
					selectionBuffer,
					members
				);
				const { height, light, shade, distance, flow, paint, islands } =
					maps.textures;
				largeWater.set({
					height,
					light,
					shade,
					distance,
					flow,
					paint,
					islands,
					rings: cached,
				});
				activeWater = largeWater;
			}
			const { frame: grid } = maps;
			// A pixel's width at a unit of distance, in the film.
			const pixel = (2 * view.aperture[1]) / size[1];
			clip = clipLayout(view.eye, pixel, grid, clip?.stride);
			const terrainSet = terrainUniforms(view, clip, grid, look);
			for (const d of terrain) {
				d.set(terrainSet);
			}
			activeWater.set(waterUniforms(view, grid, look));
			const density = JSON.stringify([look.debris, look.top, look.sandHeight]);
			if (
				!sameTextures(placedOn, maps.textures, DEBRIS_MAPS) ||
				placedWith !== density
			) {
				debris.place(frame, grid, maps.textures, look.debris, look);
				placedOn = maps.textures;
				placedWith = density;
			}
			for (const layer of world) {
				layer.settle(frame, grid, maps.textures);
			}
			const rings = clip.levels - 1;
			frame.pass(
				{
					target: film,
					clear: [0, 0, 0, 1],
					clearDepth: 0,
					timer: timers.terrain,
				},
				(pass) => {
					pass.draw(square, { instances: 1, firstInstance: 0 });
					if (rings > 0) {
						pass.draw(ring, { instances: rings, firstInstance: 1 });
					}
					if (look.view === "shaded") {
						const light = debrisLightOf(view, look, size);
						debris.draw(pass, light);
						for (const layer of world) {
							layer.draw(pass, light, grid);
						}
					}
				}
			);
			post.resize(output.size);
			frame.pass({ target: post.frame, timer: timers.water }, activeWater);
			post.render(frame, output, postLookOf(look));
		},
		dispose() {
			largeWater?.dispose();
			selectionCache?.dispose();
			for (const item of [square, ring, water, debris, ...world, post]) {
				item.dispose();
			}
			for (const mesh of meshes) {
				mesh.destroy();
			}
			// The film and the colour buffer belong to the gpu: its dispose frees them.
		},
	};
}
