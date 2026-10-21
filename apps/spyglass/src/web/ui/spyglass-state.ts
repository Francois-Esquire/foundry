import type { FormerPackage, SpyglassData } from "../data/types";
import type { AppliedState } from "../scene/apply-plan";
import { defaultChartSettings } from "../settings/chart-settings";
import {
  defaultLandmassSettings,
  type LandmassSettings,
} from "../settings/landmass-settings";

/** What the map draws over the islands: belonging regions, or files alone. */
export type MapLayer = "belonging" | "files";

/**
 * Plain map data. React, the renderer, and shell UI have separate lifetimes.
 * The fields the scene draws are `AppliedState`, which `SpyglassMap` hands it
 * whole; the rest is the shell's.
 */
export interface SpyglassState extends AppliedState {
  /** Vite development mode enables paint timings and developer tools. */
  developer: boolean;
  /**
   * The spyglass as laid out, without the readings that arrive after load: the
   * scene is built from it, and rebuilt only when it changes.
   */
  geometry: SpyglassData;
  hoveredWreck: FormerPackage | null;
  /** Why the import edges a trace asked for could not be read; null when they could, or have not been asked for. */
  importsFailure: string | null;
  /** Whether the import edges a trace asked for are being read. */
  importsReading: boolean;
  layoutSettings: LandmassSettings;
  mapLayer: MapLayer;
  selectedWreck: FormerPackage | null;
}

export function createSpyglassState(
  data: SpyglassData,
  developer = false
): SpyglassState {
  return {
    belongingLayer: null,
    chartSettings: {
      ...defaultChartSettings,
      boundaries: { ...defaultChartSettings.boundaries },
      camera: { ...defaultChartSettings.camera },
      composition: {
        hidden: [...defaultChartSettings.composition.hidden],
        solo: [...defaultChartSettings.composition.solo],
      },
      layers: { ...defaultChartSettings.layers },
      rendering: { ...defaultChartSettings.rendering },
    },
    data,
    developer,
    domain: null,
    geometry: data,
    hoveredWreck: null,
    importsFailure: null,
    importsReading: false,
    layoutSettings: { ...defaultLandmassSettings },
    legendHeight: 0,
    mapLayer: "belonging",
    responsibility: null,
    selectedWreck: null,
    selection: null,
    showConnections: false,
    territoryLayout: null,
  };
}
