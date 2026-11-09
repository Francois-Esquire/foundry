import type { SpyglassData } from "../data/types";
import type { ChartSettings } from "../settings/chart-settings";
import type { MapLabel } from "./labels";

/**
 * What one repaint of the labels and the chrome reads, held in one place
 * and written by the map (`ui/islands-map.tsx`) before each repaint.
 */
export interface ViewState {
  /** The spyglass being drawn. */
  drawingData: SpyglassData;
  /** The labels the last repaint placed. */
  labels: MapLabel[];
  legendHeight: number;
  /**
   * The spyglass the ink reads: the one the map opened with, until the
   * late readings arrive; the geometry never changes.
   */
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
