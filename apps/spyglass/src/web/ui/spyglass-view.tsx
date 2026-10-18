import { useCallback, useRef, useState } from "react";
import type { SpyglassData } from "../data/types";
import type { LateReadings } from "../load-spyglass";
import { SpyglassMap } from "./spyglass-map";
import { SpyglassShell, type SpyglassShellHandle } from "./spyglass-shell";
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
  const shell = useRef<SpyglassShellHandle>(null);
  const openSettings = useCallback(() => shell.current?.openSettings(), []);
  const map = (
    <SpyglassMap
      mapRef={actions.scene}
      onSettings={mapOnly ? undefined : openSettings}
      onViewTerritory={actions.viewTerritory}
      state={state}
    />
  );
  if (mapOnly) {
    return <main className="spyglass-map-only">{map}</main>;
  }
  return (
    <SpyglassShell actions={actions} ref={shell} state={state}>
      {map}
    </SpyglassShell>
  );
}
