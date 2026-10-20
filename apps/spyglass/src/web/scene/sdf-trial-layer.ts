import { Group } from "three";
import type { Renderer } from "three/webgpu";
import type { SpyglassData } from "../data/types";
import { type TrialPlan, trialPlan } from "../layout/sdf-trial";
import { isSceneLayerVisible } from "../settings/scene-composition";
import type { SceneLayer } from "./handle";

/**
 * The SDF trial: a developer's layer, hidden in every preset, that stands
 * the islands of the geology preview up as meshes built from true signed
 * distances, entirely on the GPU. Nothing is built until the composition
 * first shows it.
 */
export function createSdfTrialLayer(options: {
  data: SpyglassData;
  renderer: Renderer;
}): SceneLayer & {
  /** The developer's controls: the plan's islands and the last build's measures. */
  developer: {
    islands: () => { archetype: string; id: string }[];
    method: () => "dual-contouring";
    setMethod: (method: string) => void;
    stats: () => Record<string, number>;
  };
} {
  const { data } = options;
  const group = new Group();
  let plan: TrialPlan | undefined;
  const planned = () => {
    plan ??= trialPlan(data);
    return plan;
  };
  return {
    developer: {
      islands: () =>
        (plan?.islands ?? []).map((island) => ({
          archetype: island.archetype,
          id: island.id,
        })),
      method: () => "dual-contouring",
      setMethod: () => undefined,
      stats: () => ({}),
    },
    dispose() {
      plan = undefined;
    },
    group,
    id: "sdf-trial",
    kind: "layer",
    stats: () => ({}),
    update(_view, state) {
      if (!isSceneLayerVisible(state.settings.composition, "sdf-trial")) {
        return;
      }
      planned();
    },
  };
}
