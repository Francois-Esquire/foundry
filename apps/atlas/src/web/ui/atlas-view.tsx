import { useCallback, useRef, useState } from "react";
import type { LateCodex } from "../codex/vocabulary";
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
  late?: Promise<LateCodex>;
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
      onEscape={actions.escape}
      onHover={actions.hover}
      onSelect={actions.select}
      onSettings={mapOnly ? undefined : openSettings}
      onTrades={actions.trades}
      onViewTerritory={actions.viewTerritory}
      onWreck={actions.wreck}
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
