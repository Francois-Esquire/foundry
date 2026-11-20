import type { SpyglassData } from "../data/types";
import type { ChartSettings } from "../settings/chart-settings";
import type { SelectionRef } from "../view/map-contract";

export interface AppliedState {
  chartSettings: ChartSettings;
  data: SpyglassData;
  legendHeight: number;
  selection: SelectionRef | null;
  showConnections: boolean;
}
