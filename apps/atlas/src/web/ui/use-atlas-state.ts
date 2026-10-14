import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BelongingLayer } from "../belonging";
import { relayoutAtlas } from "../geography";
import type { LateReadings } from "../load-atlas";
import { type AtlasData, islandSource, type Territory } from "../types";
import type { AtlasMapHandle } from "./atlas-map";
import {
  type AtlasState,
  createAtlasState,
  type MapLayer,
} from "./atlas-state";
import { useBelonging } from "./use-belonging";

/** Rendering and camera state, independent of the bottom sheets. */
export function useAtlasState(
  initial: AtlasState,
  late?: Promise<LateReadings>
) {
  const [chartSettings, settings] = useState(initial.chartSettings);
  const [layoutSettings, setLayoutSettings] = useState(initial.layoutSettings);
  const [mapLayer, setMapLayer] = useState<MapLayer>(initial.mapLayer);
  const [viewTerritory, setViewTerritory] = useState<Territory | null>(null);
  const scene = useRef<AtlasMapHandle | null>(null);
  const geometry = useMemo(
    () =>
      layoutSettings === initial.layoutSettings
        ? initial.data
        : relayoutAtlas(initial.data, layoutSettings.islandClearance),
    [initial.data, initial.layoutSettings, layoutSettings]
  );
  const readings = useLateReadings(late);
  const data = useMemo(
    () => (readings ? withLateReadings(geometry, readings) : geometry),
    [geometry, readings]
  );
  const belonging = useBelonging(
    viewTerritory ?? undefined,
    viewTerritory ? islandSource(data, viewTerritory.id) : undefined,
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
  const reset = useCallback(
    () => settings(createAtlasState(initial.data).chartSettings),
    [initial.data]
  );
  const state: AtlasState = {
    ...initial,
    belongingLayer,
    chartSettings,
    data,
    geometry,
    layoutSettings,
    mapLayer,
  };
  return {
    mapLayer: setMapLayer,
    reset,
    scene,
    settings,
    state,
    viewTerritory: setViewTerritory,
  };
}

function withLateReadings(atlas: AtlasData, late: LateReadings): AtlasData {
  return {
    ...atlas,
    frames: atlas.frames.map((frame) => {
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
