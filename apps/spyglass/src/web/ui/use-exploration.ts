import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useRef,
  useState,
} from "react";
import type { ChartSettings } from "../settings/chart-settings";
import type { SpyglassMapHandle } from "./spyglass-map";

/** The scene owns navigation; React temporarily lends it the diorama presentation. */
export function useExploration(
  scene: RefObject<SpyglassMapHandle | null>,
  presentation: number,
  settings: Dispatch<SetStateAction<ChartSettings>>
) {
  const [exploring, setExploring] = useState(false);
  const [explorationFailure, setFailure] = useState<string | null>(null);
  const previous = useRef<number | null>(null);
  const startExploration = useCallback(() => {
    if (previous.current !== null) {
      return;
    }
    if (!scene.current?.startExploration()) {
      setFailure(
        "Exploration needs a visible ocean, a boat, and open water to launch."
      );
      return;
    }
    previous.current = presentation;
    setFailure(null);
    settings((current) => ({ ...current, presentation: 1 }));
    setExploring(true);
  }, [presentation, scene, settings]);
  const stopExploration = useCallback(() => {
    const saved = previous.current;
    if (saved === null) {
      return false;
    }
    previous.current = null;
    scene.current?.steer({ x: 0, y: 0 });
    scene.current?.stopExploration();
    settings((current) => ({ ...current, presentation: saved }));
    setExploring(false);
    return true;
  }, [scene, settings]);
  return { explorationFailure, exploring, startExploration, stopExploration };
}
