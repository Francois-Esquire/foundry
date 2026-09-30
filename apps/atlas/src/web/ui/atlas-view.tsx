import { useCallback, useRef, useState } from "react";
import type { AtlasData } from "../types";
import { AtlasMap } from "./atlas-map";
import { AtlasShell, type AtlasShellHandle } from "./atlas-shell";
import { createAtlasState } from "./atlas-state";
import { useAtlasState } from "./use-atlas-state";

export default function Atlas({
  data,
  mapOnly = false,
}: {
  data: AtlasData;
  mapOnly?: boolean;
}) {
  const [initial] = useState(() => createAtlasState(data));
  const { state, ...actions } = useAtlasState(initial);
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
