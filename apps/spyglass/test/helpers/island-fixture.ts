import type { SpyglassData, Territory } from "../../src/web/data/types";
import { singleFrame } from "./frames";

export const island: Territory = {
  analyzed: true,
  coast: [],
  fileRoles: undefined,
  files: ["one", "two"].map((id, index) => ({
    directory: "src",
    highFanIn: false,
    id,
    incoming: 0,
    internalFanIn: 0,
    kind: "source",
    outgoing: 0,
    path: `src/${id}.ts`,
    x: index * 60 - 30,
    y: 0,
  })),
  folder: "",
  highFanInCutoff: 0,
  hills: [],
  id: "island",
  label: "Island",
  radius: 80,
  responsibilityGroups: undefined,
  shallows: [],
  x: 0,
  y: 0,
};

export const twoIslands: SpyglassData = {
  coverage: "test",
  fileEdges: [],
  frames: [singleFrame([])],
  height: 500,
  packageLayers: {},
  routes: [
    {
      consumerFiles: [],
      from: "island",
      sharedConcepts: 0,
      supplierFiles: [],
      to: "other",
      weight: 1,
    },
  ],
  territories: [
    island,
    {
      ...island,
      files: [],
      id: "other",
      label: "Other",
      x: 200,
    },
  ],
  width: 500,
};
