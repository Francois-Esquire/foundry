import type {
  Polygon,
  SpyglassData,
  SpyglassFile,
  Territory,
} from "../data/types";

/** A repeatable art-direction fixture, kept separate from scanned geography. */
export function renderingStudy(): SpyglassData {
  const sites = [
    [-30, -22],
    [25, -24],
    [-25, 26],
    [4, 3],
    [38, 12],
    [12, 35],
    [-45, 3],
    [3, -40],
    [49, -13],
    [-7, 52],
    [33, 40],
    [-40, 43],
  ] as const;
  const paths = [
    "harbor.ts",
    "navigation.ts",
    "chart.ts",
    "coordinates.ts",
    "wind.ts",
    "routes.ts",
    "coast.ts",
    "compass.ts",
    "labels.ts",
    "palette.ts",
    "tides.ts",
    "chart.test.ts",
  ];
  const edges = [0, 1, 2].map((index) => ({
    source: `study/${paths[index]}`,
    target: "study/coordinates.ts",
  }));
  const files: SpyglassFile[] = sites.map(([x, y], index) => ({
    directory: "src",
    highFanIn: index === 3,
    id: `study/${paths[index]}`,
    incoming: index === 3 ? 3 : 0,
    internalFanIn: index === 3 ? 3 : 0,
    kind: index === 11 ? "test" : "source",
    outgoing: index < 3 ? 1 : 0,
    path: `src/${paths[index]}`,
    x,
    y,
  }));
  const ring: [number, number][] = Array.from({ length: 96 }, (_, index) => {
    const angle = (index * Math.PI * 2) / 96;
    const radius =
      83 +
      9 * Math.sin(angle * 3 + 0.6) +
      5 * Math.sin(angle * 7) +
      2 * Math.cos(angle * 13);
    return [Math.cos(angle) * radius, Math.sin(angle) * radius * 0.85];
  });
  ring.push([...(ring[0] ?? [0, 0])]);
  const coast: Polygon = [ring];
  const territory: Territory = {
    analyzed: true,
    coast: [coast],
    fileRoles: undefined,
    files,
    folder: "study",
    highFanInCutoff: 3,
    hills: [],
    id: "harbor",
    label: "Harbor study",
    radius: 100,
    responsibilityGroups: undefined,
    shallows: [],
    x: 0,
    y: 0,
  };
  return {
    coverage: "Synthetic rendering study",
    fileEdges: edges,
    folderCells: {},
    frames: [
      {
        dataset: { generatedAt: "study", root: "" },
        id: "",
        label: "",
        readings: {
          domains: { declared: [], placements: {} },
          nesting: { folders: [], pathRegions: [], seams: [] },
          placement: { dominantShare: 0.6, labelled: [], places: {} },
          proximity: {
            apart: { coChanges: [], files: [] },
            close: [],
            labelled: [],
          },
        },
        territories: ["harbor"],
      },
    ],
    height: 270,
    packageLayers: { harbor: 0 },
    routes: [],
    territories: [territory],
    width: 360,
  };
}
