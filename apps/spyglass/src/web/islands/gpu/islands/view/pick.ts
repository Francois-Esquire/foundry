/**
 * The pick: one dispatch of pick.wgsl, encoded at the head of a frame over
 * the film's depth as the last frame left it, which keeps what is chosen
 * and hovered in `selection`, the buffer the water highlights from. The
 * highlight follows in the same frame with no readback; `read` brings the
 * selection back for the readouts, a round trip later.
 */
import {
	type Compute,
	compute,
	type Frame,
	type Gpu,
	type ShaderSource,
	type StorageBuffer,
	storage,
	type Target,
} from "vgpu";
import type { MapSource } from "../maps/maps";
import { rayUniform } from "../scene/frame-uniforms";
import type { View } from "./camera";
import { type Chosen, selectionOf, selectionWords } from "./selection";

/** What a pick does (pick.wgsl `Pick.mode`). */
export const PICK_MODES = {
	hover: 0,
	choose: 1,
	letGo: 2,
	leave: 3,
} as const;

export type PickMode = keyof typeof PICK_MODES;

export interface Picker {
	/**
	 * Writes a choice made by id rather than by a pick, keeping `hovered` as
	 * it was last read; the next frame highlights it.
	 */
	choose: (chosen: Chosen, hovered: Chosen) => void;
	dispose: () => void;
	/** Encodes a pick of the ground at screen uv, as `view` drew it into the film. */
	pick: (
		frame: Frame,
		mode: PickMode,
		view: View,
		uv: readonly [number, number],
		maps: MapSource
	) => void;
	read: () => Promise<{ chosen: Chosen; hovered: Chosen }>;
	/** The chosen and the hovered, as water.wgsl reads them. */
	readonly selection: StorageBuffer;
}

export function createPicker(
	gpu: Gpu,
	shader: ShaderSource,
	film: Target
): Picker {
	const selection = storage(gpu, 16, "read-write");
	const kernel: Compute = compute(gpu, shader, {
		label: "islands-pick",
		set: { filmDepth: film, selection },
	});
	return {
		selection,
		pick(frame, mode, view, uv, maps) {
			const { distance, islands, rings } = maps.textures;
			kernel.set({
				distance,
				islands,
				rings,
				pick: {
					...rayUniform(view),
					mode: PICK_MODES[mode],
					uv,
					origin: maps.frame.origin,
					texel: maps.frame.texel,
					resolution: maps.frame.resolution,
				},
			});
			frame.computePass((pass) => pass.dispatch(kernel, 1));
		},
		choose(chosen, hovered) {
			selection.write(selectionWords(chosen, hovered));
		},
		async read() {
			return selectionOf(new Uint32Array(await selection.read()));
		},
		dispose() {
			kernel.dispose();
		},
	};
}
