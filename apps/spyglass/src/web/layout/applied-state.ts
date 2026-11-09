import type { SpyglassData } from "../data/types";
import type { ChartSettings } from "../settings/chart-settings";
import type { SelectionRef } from "../view/map-contract";

/**
 * The part of the viewer's state the map draws: one snapshot, applied whole.
 * The UI's state (`ui/spyglass-state.ts`) extends it; the map
 * (`ui/islands-map.tsx`) reads it.
 */
export interface AppliedState {
  chartSettings: ChartSettings;
  /** The spyglass with its late readings; the geometry the map was built from never changes. */
  data: SpyglassData;
  /** The legend's height in CSS pixels, which the latitude scale stops short of. */
  legendHeight: number;
  /**
   * The selection, which the map focuses: the island and file it names
   * become the view state's, and the camera flies there; null is the
   * overview. The only writer of the drawn selection.
   */
  selection: SelectionRef | null;
  showConnections: boolean;
}
