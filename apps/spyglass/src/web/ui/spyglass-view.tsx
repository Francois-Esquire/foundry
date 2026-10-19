import { useState } from "react";
import type { SpyglassData } from "../data/types";
import type { LateReadings } from "../layout/load-spyglass";
import { SpyglassMap } from "./spyglass-map";
import { SpyglassShell } from "./spyglass-shell";
import { createSpyglassState } from "./spyglass-state";
import { useSpyglassState } from "./use-spyglass-state";

export default function Spyglass({
  data,
  developer = false,
  late,
  mapOnly = false,
}: {
  data: SpyglassData;
  /** The readings read after load (`loadLateReadings`), merged when they arrive. */
  late?: Promise<LateReadings>;
  /** A developer session; see `SpyglassState.developer`. */
  developer?: boolean;
  mapOnly?: boolean;
}) {
  const [initial] = useState(() => createSpyglassState(data, developer));
  const { state, ...actions } = useSpyglassState(initial, late);
  const map = (
    <SpyglassMap
      mapRef={actions.scene}
      onEscape={actions.home}
      onSelect={actions.select}
      onViewTerritory={actions.viewTerritory}
      state={state}
    />
  );
  if (mapOnly) {
    return <main className="spyglass-map-only">{map}</main>;
  }
  return (
    <SpyglassShell actions={actions} state={state}>
      {map}
    </SpyglassShell>
  );
}
