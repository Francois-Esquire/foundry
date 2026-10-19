import { type RefObject, useCallback, useRef, useState } from "react";
import type { SpyglassMapHandle } from "./spyglass-map";

/** The scene owns navigation and restores the captured map view on return. */
export function useExploration(scene: RefObject<SpyglassMapHandle | null>) {
  const [exploring, setExploring] = useState(false);
  const [explorationFailure, setFailure] = useState<string | null>(null);
  const active = useRef<SpyglassMapHandle | null>(null);
  const startExploration = useCallback(() => {
    if (active.current !== null) {
      return;
    }
    const navigator = scene.current;
    if (!navigator?.startExploration()) {
      setFailure(
        "Exploration needs a visible ocean, a boat, and open water to launch."
      );
      return;
    }
    active.current = navigator;
    setFailure(null);
    setExploring(true);
  }, [scene]);
  const stopExploration = useCallback(() => {
    const navigator = active.current;
    if (navigator === null) {
      return false;
    }
    active.current = null;
    navigator.steer({ x: 0, y: 0 });
    navigator.stopExploration();
    setExploring(false);
    return true;
  }, []);
  return { explorationFailure, exploring, startExploration, stopExploration };
}
