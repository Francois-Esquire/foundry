/** Large-chart footprint decoding is paid only when selection or baked maps change. */
import {
	compute,
	type Frame,
	type Gpu,
	type ShaderSource,
	type StorageBuffer,
	storage,
	type Texture,
	texture,
} from "vgpu";
import type { MapSource } from "../maps/maps";

export interface SelectionShaders {
	selectionPrepare: ShaderSource;
	selectionResolve: ShaderSource;
}

export function createSelectionCache(gpu: Gpu, shaders: SelectionShaders) {
	const previous = storage(gpu, 16, "read-write");
	const args = storage(gpu, 12, { access: "read-write", indirect: true });
	const prepare = compute(gpu, shaders.selectionPrepare, {
		label: "islands-selection-prepare",
		set: { previous, args },
	});
	const resolve = compute(gpu, shaders.selectionResolve, {
		label: "islands-selection-resolve",
	});
	let output: Texture | undefined;
	let source: Texture | undefined;
	let memberBuffer: StorageBuffer | undefined;
	return {
		encode(
			frame: Frame,
			maps: MapSource,
			selection: StorageBuffer,
			members: StorageBuffer
		): Texture {
			const baked = maps.selection;
			if (!baked) {
				throw new Error("Large-chart selection requires baked footprints.");
			}
			const { resolution } = maps.frame;
			let force = source !== baked.footprints || memberBuffer !== members;
			if (output?.size[0] !== resolution) {
				output?.destroy();
				output = texture(gpu, {
					kind: "2d",
					size: [resolution, resolution],
					format: "rgba16uint",
					usage: ["storage_binding", "texture_binding", "copy_src"],
					label: "islands-selection-cache",
				});
				force = true;
			}
			source = baked.footprints;
			memberBuffer = members;
			prepare.set({ selection, params: { resolution, force: force ? 1 : 0 } });
			resolve.set({
				selection,
				members,
				params: { wordsPerBank: baked.wordsPerBank },
				footprints: baked.footprints,
				islands: maps.textures.islands,
				output,
			});
			frame.computePass((pass) => pass.dispatch(prepare, 1));
			frame.computePass((pass) => pass.dispatch(resolve, { indirect: args }));
			return output;
		},
		dispose() {
			prepare.dispose();
			resolve.dispose();
			output?.destroy();
		},
	};
}
