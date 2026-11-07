import type { SpyglassData } from "../data/types";
import type { AppliedState } from "../layout/applied-state";
import { defaultChartSettings } from "../settings/chart-settings";

/**
 * Plain map data. React, the renderer, and shell UI have separate lifetimes.
 * The fields the map draws are `AppliedState`, which `IslandsMap` reads
 * whole; the rest is the shell's.
 */
export interface SpyglassState extends AppliedState {
  /** Vite development mode enables paint timings and developer tools. */
  developer: boolean;
  /**
   * The spyglass as laid out, without the readings that arrive after load:
   * the map is opened from it, and opened again only when it changes.
   */
  geometry: SpyglassData;
  /** Why the import edges a trace asked for could not be read; null when they could, or have not been asked for. */
  importsFailure: string | null;
  /** Whether the import edges a trace asked for are being read. */
  importsReading: boolean;
}

export function createSpyglassState(
  data: SpyglassData,
  developer = false
): SpyglassState {
  return {
    chartSettings: {
      ...defaultChartSettings,
      composition: { ...defaultChartSettings.composition },
    },
    data,
    developer,
    geometry: data,
    importsFailure: null,
    importsReading: false,
    legendHeight: 0,
    selection: null,
    showConnections: false,
  };
}
