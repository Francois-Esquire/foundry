import { chartGrid } from "../data/bindings";
import { detailLevel } from "../view/detail-level";

export const grounds = {
  continent: "#c4cca0",
  deepWater: "#c7d2c7",
  labelHalo: "#f5efdf",
  land: "#f1ead9",
  openWater: "#b4c4c5",
  sea: "#c8d1c3",
  shallows: "#e3e6d7",
  shoreWater: "#dfe3d3",
  surf: "#eef1e6",
} as const;
type Ground = "land" | "labelHalo" | "openWater" | "sea";

export const zooms = { close: 10, island: 2.2, overview: 1 } as const;

const enteredAt = 1.8;

export const rungs = [
  "selection",
  "departure",
  "crossing",
  "file",
  "label",
  "domain",
  "tie",
  "cell",
  "coast",
  "relief",
  "sea",
] as const;
export type Rung = (typeof rungs)[number];

export const rungFloor: Record<Rung, number> = {
  cell: 3,
  coast: 1.8,
  crossing: 6,
  departure: 8,
  domain: 4,
  file: 5.5,
  label: 4.5,
  relief: 1.25,
  sea: 1,
  selection: 10,
  tie: 3.5,
};

export const districtPigments = {
  matched: "#a47b42",
  palette: ["#688c77", "#b77864", "#798cac", "#a48a54", "#9e7992", "#609b9b"],
  unresolved: "#956f47",
} as const;

export const districtPigment = "district pigment";

export const inks = {
  coastFrame: "#5a4a2e",
  coastPen: "#7a6a50",
  coastRule: "#c9a443",
  crossing: "#580490",
  declaration: "#4a4233",
  declarationBlocker: "#963f32",
  departure: "#681049",
  departureLine: "#5e0d42",
  domain: "#1e6ccc",
  domainName: "#125ecc",
  enteredRing: "#4f4634",
  evidence: "#875222",
  files: {
    config: "#894215",
    other: "#575447",
    source: "#624427",
    story: "#4c4485",
    test: "#2f5e75",
  },
  focusHalo: "#faf4e4",
  folder: "#5f5980",
  folderLine: "#8975a3",
  grid: "#6c6852",
  gridReference: "#614821",
  gridReferenceHalo: "#f6efdc",
  hover: "#9a5512",
  inspectionLink: "#874b37",
  inspectionRelated: "#587575",
  inspectionWarning: "#963f32",
  label: "#665e50",
  labelCaption: "#6a6254",
  labelHalo: grounds.labelHalo,
  landContour: "#806c4f",
  marsh: "#697855",
  paper: "#f1ead9",
  proximity: "#6b70b8",
  ripple: "#a8873c",
  scale: "#57523f",
  seaCaption: "#64786b",
  seaContour: "#487f78",
  selection: "#361b05",
  selectionGlow: "#f5cc80",
  stream: "#537d78",
  streamBank: "#605b47",
  streamGlint: "#fff5da",
  tracedImport: "#8a5a31",
  trade: "#875222",
} as const;

export const inkAlpha = {
  coastFrame: 0.55,
  coastPen: 0.85,
  gridMajor: 0.17,
  gridMinor: (pixels: number) => chartGrid(pixels).minorOpacity,
  hoverBand: 0.14,
  hoverLine: 1,
  inspectionLink: 0.63,
  landContourMajor: 0.34,
  landContourMinor: 0.21,
  paperVeil: 0.72,
  ripple: [0.16, 0.11, 0.07] as const,
  rippleReveal: (pixels: number) =>
    Math.max(0, Math.min(1, (pixels - 0.9) / 1.4)),
  scenarioBaseline: 0.5,
  seaContourMajor: 0.18,
  seaContourMinor: 0.12,
  streamBank: 0.12,
  streamGlint: 0.75,
  valleyShade: 0.24,
} as const;

type FileInkKind = keyof typeof inks.files;

export function fileInk(kind: string): string {
  return Object.hasOwn(inks.files, kind)
    ? inks.files[kind as FileInkKind]
    : inks.files.other;
}

export interface LadderMark {
  alpha: (pixels: number) => number;
  ground: Ground;
  id: string;
  ink: string;
  rung: Rung;
}

const always = () => 1;
const atOverview = (pixels: number) => (pixels < enteredAt ? 1 : 0);
const entered = (pixels: number) => (pixels < enteredAt ? 0 : 1);

export const ladderMarks: readonly LadderMark[] = [
  {
    alpha: always,
    ground: "land",
    id: "selection",
    ink: inks.selection,
    rung: "selection",
  },
  {
    alpha: atOverview,
    ground: "sea",
    id: "selection-ring",
    ink: inks.selection,
    rung: "selection",
  },
  {
    alpha: always,
    ground: "sea",
    id: "selection-lines",
    ink: inks.selection,
    rung: "selection",
  },
  {
    alpha: always,
    ground: "land",
    id: "departure",
    ink: inks.departure,
    rung: "departure",
  },
  {
    alpha: always,
    ground: "sea",
    id: "departure-line",
    ink: inks.departureLine,
    rung: "departure",
  },
  {
    alpha: always,
    ground: "openWater",
    id: "crossing",
    ink: inks.crossing,
    rung: "crossing",
  },
  {
    alpha: always,
    ground: "land",
    id: "domain",
    ink: inks.domain,
    rung: "domain",
  },
  {
    alpha: always,
    ground: "land",
    id: "domain-name",
    ink: inks.domainName,
    rung: "label",
  },
  {
    alpha: entered,
    ground: "land",
    id: "folder-name",
    ink: inks.folder,
    rung: "label",
  },
  {
    alpha: entered,
    ground: "land",
    id: "folder-cell",
    ink: inks.folderLine,
    rung: "cell",
  },
  {
    alpha: entered,
    ground: "land",
    id: "proximity",
    ink: inks.proximity,
    rung: "tie",
  },
  {
    alpha: entered,
    ground: "sea",
    id: "entered-ring",
    ink: inks.enteredRing,
    rung: "file",
  },
  ...Object.entries(inks.files).map(
    ([kind, ink]): LadderMark => ({
      alpha: (pixels) => {
        const detail = detailLevel(pixels);
        return Math.max(detail.specks, detail.files);
      },
      ground: "land",
      id: `file-${kind}`,
      ink,
      rung: "file",
    })
  ),
  {
    alpha: always,
    ground: "land",
    id: "label",
    ink: inks.label,
    rung: "label",
  },
  {
    alpha: always,
    ground: "land",
    id: "label-caption",
    ink: inks.labelCaption,
    rung: "label",
  },
  ...(
    [
      ["island-name", inks.label],
      ["island-caption", inks.labelCaption],
      ["domain-name-on-sea", inks.domainName],
    ] as const
  ).map(
    ([id, ink]): LadderMark => ({
      alpha: always,
      ground: "labelHalo",
      id,
      ink,
      rung: "label",
    })
  ),
  {
    alpha: () => inkAlpha.coastPen,
    ground: "land",
    id: "coast-pen",
    ink: inks.coastPen,
    rung: "coast",
  },
  {
    alpha: always,
    ground: "land",
    id: "coast-rule",
    ink: inks.coastRule,
    rung: "coast",
  },
  {
    alpha: () => inkAlpha.coastFrame,
    ground: "land",
    id: "coast-frame",
    ink: inks.coastFrame,
    rung: "coast",
  },
  {
    alpha: () => inkAlpha.valleyShade,
    ground: "land",
    id: "relief",
    ink: "#000000",
    rung: "relief",
  },
  {
    alpha: () => inkAlpha.landContourMajor,
    ground: "land",
    id: "land-contour",
    ink: inks.landContour,
    rung: "relief",
  },
  {
    alpha: () => inkAlpha.gridMajor,
    ground: "sea",
    id: "grid",
    ink: inks.grid,
    rung: "sea",
  },
  {
    alpha: () => inkAlpha.gridMajor,
    ground: "land",
    id: "grid-on-land",
    ink: inks.grid,
    rung: "sea",
  },
  {
    alpha: inkAlpha.gridMinor,
    ground: "sea",
    id: "grid-minor",
    ink: inks.grid,
    rung: "sea",
  },
  {
    alpha: (pixels) => inkAlpha.rippleReveal(pixels) * inkAlpha.ripple[0],
    ground: "sea",
    id: "ripple",
    ink: inks.ripple,
    rung: "sea",
  },
  {
    alpha: () => inkAlpha.seaContourMajor,
    ground: "sea",
    id: "sea-contour",
    ink: inks.seaContour,
    rung: "sea",
  },
];

export function channels(hex: string): [number, number, number] {
  const channel = (start: number) =>
    Number.parseInt(hex.slice(start, start + 2), 16);
  return [channel(1), channel(3), channel(5)];
}

function luminance([r, g, b]: readonly number[]): number {
  const linear = (channel = 0) => {
    const c = channel / 255;
    return c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrast(ink: string, alpha: number, ground: string): number {
  const under = luminance(channels(ground));
  const over = luminance(channels(ink)) * alpha + under * (1 - alpha);
  return (Math.max(over, under) + 0.05) / (Math.min(over, under) + 0.05);
}
