import type { AtlasData, AtlasFrame, FrameReadings } from "../../src/web/types";

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
): AtlasFrame {
  return {
    dataset: { generatedAt, root: "" },
    id: "",
    label: "",
    readings: { ...noReadings, ...readings },
    territories,
  };
}

/** The atlas with its frame's readings replaced where given, and the frame holding every island. */
export function withReadings<
  T extends Pick<AtlasData, "frames" | "territories">,
>(data: T, readings: Partial<FrameReadings>): T {
  const [frame] = data.frames;
  return {
    ...data,
    frames: [
      {
        ...singleFrame(
          data.territories.map((territory) => territory.id),
          { ...(frame?.readings ?? noReadings), ...readings },
          frame?.dataset.generatedAt
        ),
      },
    ],
  };
}
