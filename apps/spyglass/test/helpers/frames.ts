import { prepareVisualization } from "../../src/lib/visualization/prepare";
import type { FrameReadings, SpyglassFrame } from "../../src/web/data/types";

/** A workspace that declares no domain, and whose lenses say nothing. */
const noReadings: FrameReadings = {
  domains: { declared: [], placements: {} },
  nesting: { folders: [], pathRegions: [], seams: [] },
  placement: { dominantShare: 0.6, labelled: [], places: {} },
  proximity: { apart: { coChanges: [], files: [] }, close: [], labelled: [] },
};

/** A single workspace's one frame, at the data root, holding the given islands. */
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
    // The map an empty workspace lays out to; a test that reads the
    // islands' geometry builds its own.
    visualization: prepareVisualization({
      modules: [],
      packages: [],
      routes: [],
    }),
  };
}
