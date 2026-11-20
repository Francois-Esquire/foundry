import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpyglassData } from "../data/types";
import type { SpyglassSelection } from "../interaction/selection";
import type { LateReadings } from "../layout/load-spyglass";
import type { MapHandle, SelectionRef } from "../view/map-contract";
import { createSpyglassState, type SpyglassState } from "./spyglass-state";

function selectionRef(place: SpyglassSelection | null): SelectionRef | null {
  if (!place) {
    return null;
  }
  return place.file
    ? { fileId: place.file.id, territoryId: place.territory.id }
    : { territoryId: place.territory.id };
}

export function useSpyglassState(
  initial: SpyglassState,
  late?: Promise<LateReadings>
) {
  const [chartSettings, settings] = useState(initial.chartSettings);
  const [selection, setSelection] = useState(initial.selection);
  const scene = useRef<MapHandle | null>(null);
  const [sceneReady, setSceneReady] = useState(false);
  const geometry = initial.data;
  const readings = useLateReadings(late);
  const data = useMemo(
    () => (readings ? withLateReadings(geometry, readings) : geometry),
    [geometry, readings]
  );
  const reset = useCallback(() => {
    settings(createSpyglassState(initial.data).chartSettings);
  }, [initial.data]);
  const select = useCallback((place: SpyglassSelection | null) => {
    setSelection(selectionRef(place));
  }, []);
  const clearSelection = useCallback(() => setSelection(null), []);
  const home = useCallback(() => {
    setSelection(null);
    scene.current?.focus(null);
  }, []);
  const state: SpyglassState = {
    ...initial,
    chartSettings,
    data,
    geometry,
    selection,
  };
  return {
    clearSelection,
    home,
    reset,
    scene,
    sceneReady,
    select,
    setSceneReady,
    settings,
    state,
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
