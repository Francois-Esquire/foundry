import type { SpyglassData } from "../data/types";
import type { ChartSettings } from "../settings/chart-settings";
import type { MapLabel } from "./labels";

export interface ViewState {
  drawingData: SpyglassData;
  labels: MapLabel[];
  legendHeight: number;
  readings: SpyglassData;
  selected: string | null;
  selectedFile: string | null;
  settings: ChartSettings;
  showConnections: boolean;
}

export function createViewState(
  data: SpyglassData,
  settings: ChartSettings
): ViewState {
  return {
    drawingData: data,
    labels: [],
    legendHeight: 0,
    readings: data,
    selected: null,
    selectedFile: null,
    settings: { ...settings },
    showConnections: false,
  };
}
