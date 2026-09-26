import { useEffect, useRef } from "react";
import { createDiveScene } from "./dive-scene";
import type { FormerPackage } from "./types";

export function WreckDive({
  wreck,
  onClose,
}: {
  wreck: FormerPackage;
  onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) {
      return;
    }
    return createDiveScene(host.current, wreck);
  }, [wreck]);
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
        <button onClick={onClose}>Return to atlas</button>
      </div>
    </aside>
  );
}
