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
import {
  type Chosen,
  SELECTION_WORDS,
  selectionOf,
  selectionWords,
} from "./selection";

const PICK_MODES = {
  choose: 1,
  hover: 0,
  leave: 3,
  letGo: 2,
} as const;

export type PickMode = keyof typeof PICK_MODES;

export interface Picker {
  choose: (chosen: Chosen, hovered: Chosen) => void;
  dispose: () => void;
  pick: (
    frame: Frame,
    mode: PickMode,
    view: View,
    uv: readonly [number, number],
    maps: MapSource
  ) => void;
  read: () => Promise<{
    chosen: Chosen;
    chosenAt: readonly [number, number];
    hovered: Chosen;
  }>;
  readonly selection: StorageBuffer;
}

export function createPicker(
  gpu: Gpu,
  shader: ShaderSource,
  film: Target
): Picker {
  const selection = storage(gpu, SELECTION_WORDS * 4, "read-write");
  const kernel: Compute = compute(gpu, shader, {
    label: "islands-pick",
    set: { filmDepth: film, selection },
  });
  return {
    choose(chosen, hovered) {
      selection.write(selectionWords(chosen, hovered));
    },
    dispose() {
      kernel.dispose();
    },
    pick(frame, mode, view, uv, maps) {
      const { distance, islands, rings } = maps.textures;
      kernel.set({
        distance,
        islands,
        pick: {
          ...rayUniform(view),
          mode: PICK_MODES[mode],
          origin: maps.frame.origin,
          resolution: maps.frame.resolution,
          texel: maps.frame.texel,
          uv,
        },
        rings,
      });
      frame.computePass((pass) => pass.dispatch(kernel, 1));
    },
    async read() {
      return selectionOf(new Uint32Array(await selection.read()));
    },
    selection,
  };
}
