import { useEffect, useRef } from "react";
import type { RenderSettings } from "../chart-settings";
import { createDiveScene } from "../scene/dive-scene";
import type { FormerPackage } from "../types";

export function WreckDive({
  wreck,
  rendering,
  onClose,
}: {
  wreck: FormerPackage;
  rendering: RenderSettings;
  onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const dive = useRef<ReturnType<typeof createDiveScene> | null>(null);
  const latest = useRef(rendering);
  latest.current = rendering;
  useEffect(() => {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: React assigns and updates this ref between renders and effects.
    if (!host.current) {
      return;
    }
    const scene = createDiveScene(host.current, wreck);
    scene.configure(latest.current);
    dive.current = scene;
    return () => {
      dive.current = null;
      scene.dispose();
    };
  }, [wreck]);
  useEffect(() => {
    dive.current?.configure(rendering);
  }, [rendering]);
  return (
    <aside aria-label={`Underwater view of ${wreck.id}`} className="atlas-dive">
      <div className="atlas-dive-scene" ref={host} />
      <div className="atlas-dive-caption">
        <div>
          <h2>{wreck.id}</h2>
          <p>
            Former package · Last observed {wreck.lastObserved.slice(0, 10)}
          </p>
          <small>Drag to orbit · Scroll to move closer</small>
        </div>
        <button onClick={onClose} type="button">
          Return to atlas
        </button>
      </div>
    </aside>
  );
}
