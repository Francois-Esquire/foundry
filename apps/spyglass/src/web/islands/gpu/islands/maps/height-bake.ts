/** Chart-sized scratch lives only during a bake; the frame still reads ordinary maps. */
import type { Frame, Gpu, StorageBuffer, Texture } from "vgpu";
import type { Chart } from "../../../data/chart";
import { capacityOf } from "./bake-layout";
import type { PackedBanks } from "./map-data";
import type { MapParams } from "./map-params";
import { heightUniforms, type MapFrame } from "./map-uniforms";

export interface BankBuffers {
  readonly banks: StorageBuffer;
  readonly islands: StorageBuffer;
  readonly members: StorageBuffer;
}

/** Bindings shared by the baker and its timing tests. */
export function heightBindings(
  params: MapParams,
  mf: MapFrame,
  packed: PackedBanks,
  buffers: BankBuffers,
  maps: { readonly distance: Texture; readonly coasts: Texture }
) {
  return {
    bankIslands: buffers.islands,
    banks: buffers.banks,
    coasts: maps.coasts,
    distance: maps.distance,
    members: buffers.members,
    params: heightUniforms(params, mf, packed),
  };
}

export interface HeightWorkspace {
  dispose: () => void;
  readonly masks: GPUBuffer;
  readonly rows: number;
  readonly states: GPUBuffer;
}

/** Stripe width is the map width. Rows fit the device's storage-binding limit. */
export function heightWorkspace(
  gpu: Gpu,
  chart: Chart,
  resolution: number
): HeightWorkspace {
  const { scalable, footprints, footprintPages: pages } = capacityOf(chart);
  const wordsPerPixel =
    (scalable ? chart.islands.length : 0) + (footprints ? pages : 0);
  const rowBytes = Math.max(16, resolution * wordsPerPixel * 16);
  const budget = Math.min(
    64 * 1024 * 1024,
    gpu.gpu.limits.maxStorageBufferBindingSize
  );
  if (rowBytes > budget) {
    throw new Error(
      `One Islands bake row needs ${rowBytes} scratch bytes; this GPU supports ${budget}.`
    );
  }
  const rows =
    wordsPerPixel === 0
      ? resolution
      : Math.max(1, Math.min(resolution, Math.floor(budget / rowBytes)));
  const states = gpu.gpu.createBuffer({
    label: "islands-bake-states",
    size: scalable ? resolution * rows * chart.islands.length * 16 : 16,
    usage: GPUBufferUsage.STORAGE,
  });
  const masks = gpu.gpu.createBuffer({
    label: "islands-bake-masks",
    size: footprints ? resolution * rows * pages * 16 : 16,
    usage: GPUBufferUsage.STORAGE,
  });
  return {
    dispose() {
      states.destroy();
      masks.destroy();
    },
    masks,
    rows,
    states,
  };
}

/** Frees temporary scratch after submission or cancellation, including caller-owned frames. */
export function releaseWorkspace(
  frame: Frame,
  workspace: HeightWorkspace
): void {
  // Submitting replaces `frame.done`: until then it is a placeholder,
  // already resolved, so read it once the frame's callback has returned.
  // A canceled frame keeps the placeholder, which frees the scratch at once.
  queueMicrotask(() => {
    frame.done.then(() => workspace.dispose());
  });
}
