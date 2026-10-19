import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { islandSource, type SpyglassData, type Territory } from "../data/types";
import type { SpyglassSelection } from "../interaction/selection";
import type { BelongingLayer } from "../layout/belonging";
import { relayoutSpyglass } from "../layout/geography";
import type { LateReadings } from "../layout/load-spyglass";
import type { SelectionRef } from "../scene/apply-plan";
import type { SpyglassMapHandle } from "./spyglass-map";
import {
  createSpyglassState,
  type MapLayer,
  type SpyglassState,
} from "./spyglass-state";
import { useBelonging } from "./use-belonging";
import { useExploration } from "./use-exploration";

/** The selection as the snapshot carries it: the island's id, and the file's when a file was named. */
function selectionRef(place: SpyglassSelection | null): SelectionRef | null {
  if (!place) {
    return null;
  }
  return place.file
    ? { fileId: place.file.id, territoryId: place.territory.id }
    : { territoryId: place.territory.id };
}

/**
 * Rendering and camera state, independent of the bottom sheets. The
 * selection lives here: a click or a label's activation writes it through
 * `select`, Escape clears it, and the scene draws it from the snapshot.
 */
export function useSpyglassState(
  initial: SpyglassState,
  late?: Promise<LateReadings>,
  readInternals = true
) {
  const [chartSettings, settings] = useState(initial.chartSettings);
  const [layoutSettings, setLayoutSettings] = useState(initial.layoutSettings);
  const [mapLayer, setMapLayer] = useState<MapLayer>(initial.mapLayer);
  const [selection, setSelection] = useState(initial.selection);
  const [viewTerritory, setViewTerritory] = useState<Territory | null>(null);
  const scene = useRef<SpyglassMapHandle | null>(null);
  const [sceneReady, updateSceneReady] = useState(false);
  const exploration = useExploration(scene);
  const { stopExploration } = exploration;
  const setSceneReady = useCallback(
    (ready: boolean) => {
      if (!ready) {
        stopExploration();
      }
      updateSceneReady(ready);
    },
    [stopExploration]
  );
  const geometry = useMemo(
    () =>
      layoutSettings.islandClearance === initial.layoutSettings.islandClearance
        ? initial.data
        : relayoutSpyglass(initial.data, layoutSettings.islandClearance),
    [
      initial.data,
      initial.layoutSettings.islandClearance,
      layoutSettings.islandClearance,
    ]
  );
  const readings = useLateReadings(late);
  const data = useMemo(
    () => (readings ? withLateReadings(geometry, readings) : geometry),
    [geometry, readings]
  );
  const belonging = useBelonging(
    viewTerritory ?? undefined,
    viewTerritory && readInternals
      ? islandSource(data, viewTerritory.id)
      : undefined,
    chartSettings.volcanic,
    chartSettings.streams
  );
  const belongingLayer: BelongingLayer | null = useMemo(
    () =>
      viewTerritory && mapLayer === "belonging"
        ? {
            features: belonging.features,
            regions: belonging.composites.length
              ? belonging.composites
              : belonging.regions,
            territory: viewTerritory,
          }
        : null,
    [
      viewTerritory,
      mapLayer,
      belonging.composites,
      belonging.regions,
      belonging.features,
    ]
  );
  useEffect(() => {
    if (
      chartSettings.coastalBuffer === layoutSettings.coastalBuffer &&
      chartSettings.islandClearance === layoutSettings.islandClearance
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      setViewTerritory(null);
      setLayoutSettings({
        coastalBuffer: chartSettings.coastalBuffer,
        islandClearance: chartSettings.islandClearance,
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [
    chartSettings.coastalBuffer,
    chartSettings.islandClearance,
    layoutSettings,
  ]);
  const reset = useCallback(() => {
    stopExploration();
    settings(createSpyglassState(initial.data).chartSettings);
  }, [initial.data, stopExploration]);
  const select = useCallback(
    (place: SpyglassSelection | null) => {
      stopExploration();
      setSelection(selectionRef(place));
    },
    [stopExploration]
  );
  const clearSelection = useCallback(() => setSelection(null), []);
  /**
   * The overview: the snapshot lets the selection go, and the camera is sent
   * home at once, selection or none, so Escape with nothing selected still
   * returns the reader to the whole spyglass.
   */
  const home = useCallback(() => {
    if (stopExploration()) {
      return;
    }
    setSelection(null);
    scene.current?.focus(null);
  }, [stopExploration]);
  const state: SpyglassState = {
    ...initial,
    belongingLayer,
    chartSettings,
    data,
    geometry,
    layoutSettings,
    mapLayer,
    selection,
  };
  return {
    ...exploration,
    clearSelection,
    home,
    mapLayer: setMapLayer,
    reset,
    scene,
    sceneReady,
    select,
    setSceneReady,
    settings,
    state,
    viewTerritory: setViewTerritory,
  };
}

function withLateReadings(
  spyglass: SpyglassData,
  late: LateReadings
): SpyglassData {
  return {
    ...spyglass,
    frames: spyglass.frames.map((frame) => {
      const read = late[frame.id];
      return read
        ? { ...frame, readings: { ...frame.readings, ...read } }
        : frame;
    }),
  };
}

/** The late readings once they arrive; a refusal is the caller's to show (`App`). */
function useLateReadings(late: Promise<LateReadings> | undefined) {
  const [readings, setReadings] = useState<LateReadings | null>(null);
  useEffect(() => {
    if (!late) {
      return;
    }
    let live = true;
    late.then(
      (value) => {
        if (live) {
          setReadings(value);
        }
      },
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [late]);
  return readings;
}
