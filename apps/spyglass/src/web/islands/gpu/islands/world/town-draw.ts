/**
 * The structures layer (WORLD.md layer 4): the world plan's buildings,
 * parcel edges, poles and wires, built into parts of the kit
 * (structures-build.ts, town-parts.ts) and packed once when the plan is
 * set; each site's ground found once on the GPU when the plan or the maps
 * change (`settle`, shaders/world/town-floors.wgsl); and everything drawn with
 * the terrain into the film (shaders/world/town.wgsl): one instanced draw a
 * shape, one for the ground shadows, one for the wires. The frame does
 * nothing in proportion to the town but the GPU's own vertex work: no
 * searching, no packing.
 */
import {
	type Compute,
	compute,
	type Draw,
	draw,
	type Gpu,
	type ShaderSource,
	type StorageBuffer,
	storage,
	type Texture,
} from "vgpu";
import { buildStructures } from "./structures-build";
import { packWires, WIRE_VEC4S } from "./structures-poles";
import {
	type PackedTown,
	packTown,
	TOWN_SHAPES,
	type TownShape,
} from "./town-parts";
import type { WorldLayer } from "./world";

export interface TownShaders {
	town: ShaderSource;
	townFloors: ShaderSource;
}

/** Quads in a roof (shaders/world/town.wgsl `ROOF_QUADS`). */
const ROOF_QUADS = 64;
/** Slices round a round, and its vertices a slice (shaders/world/town.wgsl `SEGMENTS`). */
const ROUND_SEGMENTS = 12;
const ROUND_SLICE = 15;

/** Vertices a part of each shape (shaders/world/town.wgsl `vs_box`, ...). */
export const TOWN_VERTICES: Readonly<Record<TownShape, number>> = {
	box: 30,
	roof: ROOF_QUADS * 6,
	round: ROUND_SEGMENTS * ROUND_SLICE,
	open: 36,
};
/** Cells a side of a part's shadow patch (shaders/world/town.wgsl `SHADOW_CELLS`). */
const SHADOW_CELLS = 6;
/** Segments along a wire (shaders/world/town.wgsl `WIRE_SEGMENTS`). */
const WIRE_SEGMENTS = 16;
const FLOORS_GROUP = 64;
/** Bytes a site's ground (shaders/world/town-floors.wgsl `floors`). */
const FLOOR_BYTES = 16;
const BYTES_PER_VEC4 = 16;

export function createTown(
	gpu: Gpu,
	shaders: TownShaders,
	linear: GPUSampler
): WorldLayer {
	const bodies = Object.fromEntries(
		TOWN_SHAPES.map((shape) => [
			shape,
			draw(gpu, {
				shader: shaders.town,
				label: `islands-town-${shape}`,
				entry: {
					vertex: `vs_${shape}`,
					fragment: shape === "open" ? "fs_open" : "fs_main",
				},
				cull: "none",
				depth: { compare: "greater" },
			}),
		])
	) as Record<TownShape, Draw>;
	// Over the terrain and under the town, which drew first: no depth of its own.
	const shadow: Draw = draw(gpu, {
		shader: shaders.town,
		label: "islands-town-shadows",
		entry: { vertex: "vs_shadow", fragment: "fs_shadow" },
		cull: "none",
		blend: "alpha",
		depth: { compare: "greater", write: false },
	});
	// Thin enough to cover less than a pixel, so blended by their coverage.
	const wireDraw: Draw = draw(gpu, {
		shader: shaders.town,
		label: "islands-town-wires",
		entry: { vertex: "vs_wire", fragment: "fs_wire" },
		cull: "none",
		blend: "alpha",
		depth: { compare: "greater", write: false },
	});
	const floorsPass: Compute = compute(gpu, shaders.townFloors, {
		label: "islands-town-floors",
		entry: "cs_floors",
	});
	const sized = (
		buffer: StorageBuffer,
		bytes: number,
		access: "read" | "read-write"
	) => (bytes === buffer.size ? buffer : storage(gpu, bytes, access));
	let parts: StorageBuffer = storage(gpu, 16, "read");
	let shades: StorageBuffer = storage(gpu, 16, "read");
	let sites: StorageBuffer = storage(gpu, 16, "read");
	let wires: StorageBuffer = storage(gpu, 16, "read");
	let floors: StorageBuffer = storage(gpu, FLOOR_BYTES, "read-write");
	let packed: PackedTown | undefined;
	let wireCount = 0;
	let settledOn: { height: Texture; light: Texture } | null = null;
	let height: Texture | undefined;
	return {
		set(plan) {
			const built = buildStructures(plan);
			packed = packTown(built.parts, built.sites);
			parts = sized(parts, packed.data.byteLength, "read");
			parts.write(packed.data);
			shades = sized(shades, packed.shades.byteLength, "read");
			shades.write(packed.shades);
			sites = sized(sites, packed.sites.byteLength, "read");
			sites.write(packed.sites);
			floors = sized(
				floors,
				Math.max(packed.siteCount, 1) * FLOOR_BYTES,
				"read-write"
			);
			const wireData = packWires(built.wires);
			wireCount = built.wires.length;
			wires = sized(
				wires,
				Math.max(wireCount, 1) * WIRE_VEC4S * BYTES_PER_VEC4,
				"read"
			);
			wires.write(wireData);
			settledOn = null;
		},
		settle(frame, grid, textures) {
			if (
				!packed ||
				(settledOn?.height === textures.height &&
					settledOn.light === textures.light)
			) {
				return;
			}
			settledOn = { height: textures.height, light: textures.light };
			({ height } = textures);
			const count = packed.siteCount;
			floorsPass.set({
				params: {
					origin: grid.origin,
					side: grid.texel * grid.resolution,
					count,
				},
				sites,
				height: textures.height,
				light: textures.light,
				linear,
				floors,
			});
			frame.computePass((c) =>
				c.dispatch(floorsPass, Math.max(Math.ceil(count / FLOORS_GROUP), 1))
			);
		},
		draw(pass, light, grid) {
			if (!(packed && height)) {
				return;
			}
			const props = {
				viewProjection: light.viewProjection,
				sun: light.sun,
				sunStrength: light.sunStrength,
				sunColor: light.sunColor,
				skyStrength: light.skyStrength,
				skyColor: light.skyColor,
				shadowStrength: light.shadowStrength,
				seaFill: light.seaFill,
				occlusion: light.occlusion,
				origin: grid.origin,
				side: grid.texel * grid.resolution,
				occlusionSun: light.occlusionSun,
				viewport: light.viewport,
			};
			for (const shape of TOWN_SHAPES) {
				const run = packed.runs[shape];
				if (run.count === 0) {
					continue;
				}
				bodies[shape].set({ props, parts, floors });
				pass.draw(bodies[shape], {
					vertices: TOWN_VERTICES[shape],
					instances: run.count,
					firstInstance: run.first,
				});
			}
			if (packed.shadeCount > 0) {
				shadow.set({ props, parts: shades, height, linear });
				pass.draw(shadow, {
					vertices: SHADOW_CELLS * SHADOW_CELLS * 6,
					instances: packed.shadeCount,
				});
			}
			if (wireCount > 0) {
				wireDraw.set({ props, wires, floors });
				pass.draw(wireDraw, {
					vertices: WIRE_SEGMENTS * 6,
					instances: wireCount,
				});
			}
		},
		async compile(film) {
			await Promise.all([
				...TOWN_SHAPES.map((shape) => bodies[shape].compile(film)),
				shadow.compile(film),
				wireDraw.compile(film),
				floorsPass.compile(),
			]);
		},
		dispose() {
			for (const shape of TOWN_SHAPES) {
				bodies[shape].dispose();
			}
			shadow.dispose();
			wireDraw.dispose();
			floorsPass.dispose();
		},
	};
}
