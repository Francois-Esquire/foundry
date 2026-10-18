import type { Object3D, Scene } from "three";
import type { WebGPURenderer } from "three/webgpu";
import type { ChartSettings } from "../settings/chart-settings";
import type { ChartCamera } from "./chart-camera";
import { createRenderPipeline } from "./pipeline";

/**
 * The pass graph over the scene and the paper's occlusion shading, set
 * together from the rendering settings. A stage that finishes building after
 * the frame that asked for it reports its status on the host and asks for
 * another frame.
 */
export function createRendering(options: {
  camera: Pick<ChartCamera, "camera" | "unitsPerPixel">;
  host: HTMLElement;
  paper: { setOcclusion: (value: number) => void };
  render: () => void;
  renderer: WebGPURenderer;
  scene: Scene;
  /** The meshes of what the reader has selected, read before each frame for the selection glow. */
  selectedObjects: () => Object3D[];
}) {
  const { camera, host, paper, renderer, scene, selectedObjects } = options;
  const pipeline = createRenderPipeline({
    camera: camera.camera,
    onStatus: (status) => {
      host.dispatchEvent(
        new CustomEvent("spyglass:render", { detail: status })
      );
      options.render();
    },
    renderer,
    scene,
    selectedObjects,
    unitsPerPixel: camera.unitsPerPixel,
  });
  return {
    configure(rendering: ChartSettings["rendering"]) {
      pipeline.configure(rendering);
      paper.setOcclusion(
        rendering.quality !== "off" && rendering.ambientOcclusion
          ? rendering.aoIntensity
          : 0
      );
    },
    dispose: pipeline.dispose,
    /** Encodes and submits one frame. */
    render: pipeline.render,
    /** The registry's stages, and which the graph holds. */
    stages: pipeline.stages,
    status: pipeline.status,
  };
}
