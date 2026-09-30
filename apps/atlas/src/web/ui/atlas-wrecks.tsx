import type { MouseEvent } from "react";
import { useCallback } from "react";
import type { FormerPackage } from "../types";

/** Former packages: present in a historical checkpoint, absent from this survey. */
export function AtlasWrecks({
  wrecks,
  selected,
  onSelect,
}: {
  wrecks: FormerPackage[];
  selected: FormerPackage | null;
  onSelect: (wreck: FormerPackage) => void;
}) {
  const selectWreck = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const wreck = wrecks.find(
        (item) => item.id === event.currentTarget.value
      );
      if (wreck) {
        onSelect(wreck);
      }
    },
    [wrecks, onSelect]
  );
  return (
    <div className="atlas-wrecks">
      <h2>Former packages</h2>
      <p>Present in a historical checkpoint; absent from this survey.</p>
      <div className="atlas-wreck-list">
        {wrecks.map((wreck) => (
          <button
            aria-current={selected?.id === wreck.id ? "true" : undefined}
            key={wreck.id}
            onClick={selectWreck}
            type="button"
            value={wreck.id}
          >
            <span>{wreck.id}</span>
            <small>Last observed {wreck.lastObserved.slice(0, 10)}</small>
          </button>
        ))}
      </div>
    </div>
  );
}
