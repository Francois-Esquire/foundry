import type { SpyglassData } from "../data/types";
import type { AppliedState } from "../layout/applied-state";
import { defaultChartSettings } from "../settings/chart-settings";

export interface SpyglassState extends AppliedState {
  developer: boolean;
  geometry: SpyglassData;
  importsFailure: string | null;
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
