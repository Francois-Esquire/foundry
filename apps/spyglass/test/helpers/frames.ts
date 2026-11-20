import { prepareVisualization } from "../../src/lib/visualization/prepare";
import type { FrameReadings, SpyglassFrame } from "../../src/web/data/types";

const noReadings: FrameReadings = {
  domains: { declared: [], placements: {} },
  nesting: { folders: [], pathRegions: [], seams: [] },
  placement: { dominantShare: 0.6, labelled: [], places: {} },
  proximity: { apart: { coChanges: [], files: [] }, close: [], labelled: [] },
};

export function singleFrame(
  territories: readonly string[],
  readings: Partial<FrameReadings> = {},
  generatedAt = "test"
): SpyglassFrame {
  return {
    dataset: { generatedAt, root: "" },
    id: "",
    label: "",
    readings: { ...noReadings, ...readings },
    territories,
    visualization: prepareVisualization({
      modules: [],
      packages: [],
      routes: [],
    }),
  };
}
