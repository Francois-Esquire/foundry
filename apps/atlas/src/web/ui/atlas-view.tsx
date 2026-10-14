import { useCallback, useRef, useState } from "react";
import type { LateReadings } from "../load-atlas";
import type { AtlasData } from "../types";
import { AtlasMap } from "./atlas-map";
import { AtlasShell, type AtlasShellHandle } from "./atlas-shell";
import { createAtlasState } from "./atlas-state";
import { useAtlasState } from "./use-atlas-state";

export default function Atlas({
  data,
  developer = false,
  late,
  mapOnly = false,
}: {
  data: AtlasData;
  /** The readings read after load (`loadLateReadings`), merged when they arrive. */
  late?: Promise<LateReadings>;
  /** A developer session; see `AtlasState.developer`. */
  developer?: boolean;
  mapOnly?: boolean;
}) {
  const [initial] = useState(() => createAtlasState(data, developer));
  const { state, ...actions } = useAtlasState(initial, late);
  const shell = useRef<AtlasShellHandle>(null);
  const openSettings = useCallback(() => shell.current?.openSettings(), []);
  const map = (
    <AtlasMap
      mapRef={actions.scene}
      onSettings={mapOnly ? undefined : openSettings}
      onViewTerritory={actions.viewTerritory}
      state={state}
    />
  );
  if (mapOnly) {
    return <main className="atlas-map-only">{map}</main>;
  }
  return (
    <AtlasShell actions={actions} ref={shell} state={state}>
      {map}
    </AtlasShell>
  );
}
