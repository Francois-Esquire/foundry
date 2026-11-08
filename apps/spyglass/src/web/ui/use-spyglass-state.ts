import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpyglassData } from "../data/types";
import type { SpyglassSelection } from "../interaction/selection";
import type { LateReadings } from "../layout/load-spyglass";
import type { MapHandle, SelectionRef } from "../view/map-contract";
import { createSpyglassState, type SpyglassState } from "./spyglass-state";

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
 * `select`, Escape clears it, and the map draws it from the snapshot.
 */
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
  /**
   * The overview: the snapshot lets the selection go, and the camera is sent
   * home at once, selection or none, so Escape with nothing selected still
   * returns the reader to the whole spyglass.
   */
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
