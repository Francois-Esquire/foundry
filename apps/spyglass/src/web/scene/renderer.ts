import { AmbientLight, DirectionalLight, Scene, SRGBColorSpace } from "three";
import { WebGPURenderer } from "three/webgpu";
import { materials as lit } from "../ladder/ink-ladder";

/** The renderer in the host, ready to draw: WebGPU when the browser offers it, otherwise the WebGL 2 backend. */
export async function openRenderer(host: HTMLElement) {
  const renderer = new WebGPURenderer({
    alpha: true,
    antialias: true,
    trackTimestamp: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  host.append(renderer.domElement);
  // Nothing may render before the backend is ready.
  await renderer.init();
  return renderer;
}

/** An empty scene under the chart's light. */
export function createLitScene() {
  const scene = new Scene();
  // Balanced so level paper renders at its own pigment: (1.23 + 3.16 × 0.6) / π ≈ 1.
  scene.add(new AmbientLight(lit.light.ambient, 1.23));
  const sun = new DirectionalLight(lit.light.sun, 3.16);
  sun.position.set(-600, 700, 700);
  scene.add(sun);
  return scene;
}
