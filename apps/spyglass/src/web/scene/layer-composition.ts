import {
  isSceneLayerId,
  isSceneLayerVisible,
} from "../settings/scene-composition";
import type { InkView } from "../view/chart-view";
import type { SceneLayer } from "./handle";
import type { ViewState } from "./view-state";

/** Owns visibility and execution together, so hidden layers cannot keep doing frame work. */
export function createLayerComposition(layers: readonly SceneLayer[]) {
  const active = new Map<SceneLayer, boolean>();
  return {
    enabled(layer: SceneLayer): boolean {
      return active.get(layer) ?? false;
    },
    sync(state: Readonly<ViewState>) {
      for (const layer of layers) {
        const visible =
          (!isSceneLayerId(layer.id) ||
            isSceneLayerVisible(state.settings.composition, layer.id)) &&
          (layer.enabled?.(state) ?? true);
        if (active.get(layer) !== visible) {
          layer.setVisible?.(visible);
        }
        if (layer.group) {
          layer.group.visible = visible;
        }
        active.set(layer, visible);
      }
    },
    update(
      view: InkView,
      state: Readonly<ViewState>,
      time: number,
      measure: (layer: SceneLayer, update: () => void) => void
    ) {
      for (const layer of layers) {
        if (active.get(layer) && layer.update) {
          measure(layer, () => layer.update?.(view, state, time));
        }
      }
    },
  };
}
