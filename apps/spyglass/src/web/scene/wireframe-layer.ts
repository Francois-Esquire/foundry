import { Group, Mesh, PlaneGeometry } from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import type { SpyglassData } from "../data/types";
import { chartHull } from "../layout/chart-hull";
import type { SceneLayer } from "./handle";
import { createEmanationTexture, oceanEmanationNode } from "./ocean-emanation";

/**
 * Map units the rings' sheet stands over the water level: clear of the
 * sea's opaque plane, so the two never fight for a pixel, and well under
 * the geology lattice's gap, so no seabed vertex rises through it.
 */
const ringLift = 0.01;

/**
 * Drawn after the water's sheets at the same level, the geology preview's
 * surface among them, and before the marks' first step.
 */
const ringRenderOrder = 0.0005;

/**
 * The outer hull's rings as a transparent sheet at the water level over the
 * emanation's extent: the ring lines of `oceanEmanationNode` in their ink,
 * nothing elsewhere. The field is the geology preview's own, from the
 * cached `chartHull`.
 */
function buildHullRings(options: {
  data: Pick<SpyglassData, "frames" | "territories">;
  extent: { height: number; width: number };
}) {
  const emanationTexture = createEmanationTexture(
    chartHull(options.data, options.extent).field
  );
  const emanation = oceanEmanationNode({
    extent: emanationTexture.extent,
    texture: emanationTexture.texture,
  });
  const material = new MeshBasicNodeMaterial({
    depthWrite: false,
    transparent: true,
  });
  material.colorNode = emanation.ringColour;
  material.opacityNode = emanation.ring;
  const geometry = new PlaneGeometry(
    emanationTexture.extent.width,
    emanationTexture.extent.height
  );
  const mesh = new Mesh(geometry, material);
  mesh.position.z = ringLift;
  mesh.renderOrder = ringRenderOrder;
  return {
    dispose() {
      geometry.dispose();
      material.dispose();
      emanation.dispose();
      emanationTexture.texture.dispose();
    },
    mesh,
  };
}

type HullRingsOverlay = ReturnType<typeof buildHullRings>;

/**
 * The wireframe: a developer's layer of construction lines over the
 * chart, hidden in every preset and reached only from the layer list. It
 * holds the outer hull's rings, which the geology preview places but no
 * longer draws. Its group is empty until the composition first shows it;
 * then the overlays are built, once, and kept until the scene is disposed.
 */
export function createWireframeLayer(
  options: Parameters<typeof buildHullRings>[0]
): SceneLayer & { rings: () => HullRingsOverlay } {
  const group = new Group();
  let built: HullRingsOverlay | undefined;
  const rings = () => {
    if (!built) {
      built = buildHullRings(options);
      group.add(built.mesh);
    }
    return built;
  };
  return {
    dispose() {
      built?.dispose();
    },
    group,
    id: "wireframe",
    kind: "layer",
    rings,
    update() {
      rings();
    },
  };
}
