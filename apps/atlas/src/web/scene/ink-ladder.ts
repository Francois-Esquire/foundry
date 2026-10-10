import { chartGrid } from "../codex/bindings";
import { detailLevel } from "./detail-level";

/**
 * The ink ladder: how strongly each kind of mark is drawn, as luminance
 * contrast against the ground it sits on, and the one table of hue, dash and
 * weight that says what each line or mark means. Every colour the chart
 * scene uses is here and nowhere else under `scene/`; painters take their
 * inks from this module, the map key reads the same table, and
 * `test/web/ink-ladder.test.ts` holds every mark to its rung at each named
 * zoom.
 */

/**
 * The sheets the map is printed on. `land` and `sea` are the grounds the
 * ladder measures against; the rest are the sea sheet's depths, the
 * shallows, and connecting land.
 */
export const grounds = {
  continent: "#c4cca0",
  deepWater: "#c7d2c7",
  land: "#f1ead9",
  openWater: "#b4c4c5",
  sea: "#d5dbca",
  shallows: "#e3e6d7",
  shoreWater: "#dfe3d3",
} as const;
type Ground = "land" | "sea";

/** Named zooms, in CSS pixels per map unit: the overview, an entered island, a file close up. */
export const zooms = { close: 10, island: 2.2, overview: 1 } as const;

/**
 * From this zoom, where district pigment has fully come in, an island counts
 * as entered: its selection ring steps down to the file rung, since the
 * breadcrumb carries the selection and a strong ring around every islet
 * would read as a coast.
 */
export const enteredAt = 1.8;

/** Strongest first: this order is the ladder. */
export const rungs = [
  "selection",
  "departure",
  "file",
  "label",
  "coast",
  "relief",
  "sea",
] as const;
export type Rung = (typeof rungs)[number];

/**
 * Each rung's least contrast with its ground (the WCAG ratio, 1 to 21). A
 * mark on a rung meets its rung's floor and stays under the floor of the rung
 * above, so no mark outranks one that matters more.
 */
export const rungFloor: Record<Rung, number> = {
  coast: 1.8,
  departure: 8,
  file: 5.5,
  label: 4.5,
  relief: 1.25,
  // Sea lines fade in with zoom, so the sea rung has no floor of its own.
  sea: 1,
  selection: 10,
};

/**
 * District pigments, picked by a responsibility's id: pigment means
 * responsibility, never package. Unresolved belonging and collections take
 * `unresolved`; the regions an overlay matches take `matched`.
 */
export const districtPigments = {
  matched: "#a47b42",
  palette: ["#688c77", "#b77864", "#798cac", "#a48a54", "#9e7992", "#609b9b"],
  unresolved: "#956f47",
} as const;

/** The table's hue for rows drawn in a district's own pigment. */
const districtPigment = "district pigment";

/** Every ink a painter takes from the ladder. */
export const inks = {
  /** Packages: a coast, its gilt rule and the rule's frame. */
  coastFrame: "#5a4a2e",
  coastPen: "#7a6a50",
  coastRule: "#c9a443",
  /** The compass rose, which opens chart settings. */
  compass: "#8b7656",
  /** A declaration in a composition drawing, and one that blocks a trace. */
  declaration: "#4a4233",
  declarationBlocker: "#963f32",
  /** Departures (4.2b): magenta, with a notched ring and a dash-dot line as a second cue. */
  departure: "#681049",
  /** The selected island's ring once it is entered: file-rung strength. */
  enteredRing: "#4f4634",
  /** Evidence in focus in the architecture overlays, and their proposals. */
  evidence: "#875222",
  /**
   * File marks by kind; `unknown` takes `other`. None is magenta, which
   * departures own, and every two stay apart under deutan, protan, and tritan
   * vision, since at overview every file is the same dot.
   */
  files: {
    config: "#894215",
    other: "#575447",
    source: "#624427",
    story: "#4c4485",
    test: "#2f5e75",
  },
  /** The paper cut around the selected file's ring. */
  focusHalo: "#faf4e4",
  /** The chart's grid, printed once on sea and land, and its references' halo. */
  grid: "#6c6852",
  gridReferenceHalo: "#e3e6d4",
  /** The island under the pointer: a mid amber, apart from the coast rule and the selection. */
  hover: "#9a5512",
  /** Links between evidence files, and files the overlay relates. */
  inspectionLink: "#874b37",
  inspectionRelated: "#587575",
  /** An unresolved or disagreeing file in an overlay. */
  inspectionWarning: "#963f32",
  /** Names and their captions; the halo is the paper they are cut from. */
  label: "#665e50",
  labelCaption: "#6a6254",
  labelHalo: "#f5efdf",
  /** Height contours over the land and distance rings on the sea. */
  landContour: "#806c4f",
  marsh: "#697855",
  /** Paper itself, where a mark is cut from what is under it. */
  paper: "#f1ead9",
  /** Barely-there gilt water lines near each coast. */
  ripple: "#a8873c",
  /** The latitude scale in the right margin: dependency layers, foundation to the south. */
  scale: "#57523f",
  /** The sea's name and the chart's caveat. */
  seaCaption: "#64786b",
  seaContour: "#487f78",
  /** The selection: an island's ring at overview and its lines, a file's ring and name, a feature's outline. */
  selection: "#3b1e06",
  stream: "#537d78",
  streamBank: "#605b47",
  streamGlint: "#fff5da",
  tracedImport: "#8a5a31",
  trade: "#875222",
} as const;

/** How opaque each ladder ink is drawn; the zoom-dependent ones are functions of pixels per unit. */
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
  /** A paper veil under a proposed position. */
  paperVeil: 0.72,
  /**
   * Relief is one hillshade term, multiplying the paper's linear colour by
   * 1 minus at most this much, so the steepest shade clears the relief floor.
   */
  reliefCap: 0.22,
  ripple: [0.16, 0.11, 0.07] as const,
  /** Ripples surface as the camera comes in. */
  rippleReveal: (pixels: number) =>
    Math.max(0, Math.min(1, (pixels - 0.9) / 1.4)),
  scenarioBaseline: 0.5,
  seaContourMajor: 0.18,
  seaContourMinor: 0.12,
  streamBank: 0.12,
  streamGlint: 0.75,
} as const;

/** Colours of the scene's lit materials and lights, which are not inks on the map. */
export const materials = {
  /** Every island's low coast wall: the land a shade toward earth. */
  cliffEarth: "#8a6a45",
  /** The wreck dive's water, light and seabed. */
  dive: {
    ambient: "#b4d8c8",
    dust: "#d8e8d6",
    fill: "#9bc8bd",
    floor: "#8f9c89",
    rock: "#75877b",
    shaft: "#c5e2cc",
    silt: "#82988a",
    sun: "#e1ecd0",
    timber: "#566d61",
    water: "#4a7778",
  },
  /** The chart's ambient fill and warm sun, for the sea and the coast walls. */
  light: { ambient: "#ffffff", sun: "#fffaf4" },
  /** A wreck's timbers, hold, ribs, sail, seabed and rigging. */
  wreck: {
    bone: "#829785",
    canvas: "#95aa9e",
    hold: "#304a47",
    rigging: "#667f74",
    seabed: "#a9bdad",
    timber: "#4b655d",
  },
} as const;

/** A developer session's inks: the layout's outlines and the roads, outside the reader's ladder. */
export const developerInks = {
  boundaries: {
    clearance: "#866279",
    coasts: "#555e42",
    footprint: "#3f716b",
    groups: "#766549",
    outer: "#596f68",
    pockets: "#a06438",
  },
  road: "#997c4e",
} as const;

type FileInkKind = keyof typeof inks.files;

/** A file mark's ink by kind; a kind the ladder does not name takes `other`. */
export function fileInk(kind: string): string {
  return Object.hasOwn(inks.files, kind)
    ? inks.files[kind as FileInkKind]
    : inks.files.other;
}

/** One mark the ladder rules, with its opacity at a zoom; 0 means it is not drawn there. */
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

/**
 * Every mark on the ladder, as the painters draw it at rest: nothing
 * hovered, no overlay receding the other files. Departures have a rung and an
 * ink but no painter until 4.2b. Optional layers and on-demand ink (trade
 * lanes, streams, marsh drains, traced imports, the architecture overlays,
 * hover) are outside the rung order; the table below still keeps each
 * apart.
 */
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
    ink: inks.departure,
    rung: "departure",
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
    // The paper's linear colour times 1 − cap is black over it at the cap.
    alpha: () => inkAlpha.reliefCap,
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

/** `#rrggbb` as its three channels, 0 to 255. */
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

/**
 * The WCAG contrast ratio of `ink` at `alpha` over `ground`, against the
 * ground itself, blended in linear light as the renderer blends: the ink and
 * lettering canvases are sRGB textures composited over the scene in linear,
 * and the paper's relief term multiplies its linear colour. Luminance is
 * linear in the channels, so blending luminances is blending colours.
 */
export function contrast(ink: string, alpha: number, ground: string): number {
  const under = luminance(channels(ground));
  const over = luminance(channels(ink)) * alpha + under * (1 - alpha);
  return (Math.max(over, under) + 0.05) / (Math.min(over, under) + 0.05);
}

/** A line's dash in screen pixels; empty is solid. */
type Dash = readonly number[];

/** One row of the hue × dash × weight table: what a line or mark means. */
export interface InkStyle {
  /** A second cue beside the hue, for readers who cannot tell the hue apart. */
  cue?: string;
  dash: Dash;
  /** Drawn by a reader's map today; departures wait for 4.2b. */
  drawn: boolean;
  hue: string;
  id: string;
  /** Lines and marks can be confused with each other; fills and text only with their own kind. */
  kind: "fill" | "line" | "text";
  meaning: string;
  /** Dash and weight are in screen pixels unless the row says map units, as a sea lane's are. */
  units?: "map";
  /** Line width in screen pixels; 0 for a fill or text. */
  weight: number;
}

const line = (
  id: string,
  hue: string,
  weight: number,
  meaning: string,
  dash: Dash = [],
  extra: Partial<InkStyle> = {}
): InkStyle => ({
  dash,
  drawn: true,
  hue,
  id,
  kind: "line",
  meaning,
  weight,
  ...extra,
});

const flat = (
  id: string,
  kind: "fill" | "text",
  hue: string,
  meaning: string
): InkStyle => ({ dash: [], drawn: true, hue, id, kind, meaning, weight: 0 });

/**
 * Every line, mark, fill and text a reader's map can show, by hue, dash and
 * weight. No two rows of one kind share all three, so no two meanings look
 * alike; the map key reads its rows from here.
 */
export const inkTable: readonly InkStyle[] = [
  line(
    "selection",
    inks.selection,
    1.8,
    "The selection: an island's ring at overview, a file's ring and name, a feature's outline"
  ),
  line(
    "selection-imports",
    inks.selection,
    1.4,
    "A package the selected island imports from",
    [7, 5]
  ),
  line(
    "selection-importers",
    inks.selection,
    1.4,
    "A package that imports the selected island",
    [0.1, 4]
  ),
  line(
    "entered-ring",
    inks.enteredRing,
    1,
    "The selected island's ring, once it is entered"
  ),
  flat(
    "exact-member",
    "fill",
    inks.selection,
    "A member of the selected group, drawn solid"
  ),
  line(
    "focus-halo",
    inks.focusHalo,
    5,
    "The paper cut around the selected file's ring"
  ),
  line(
    "member-halo",
    inks.paper,
    1,
    "The paper edge around a selected group's member"
  ),
  line(
    "traced-import",
    inks.tracedImport,
    1,
    "A traced import of the selected file",
    [3, 5]
  ),
  line(
    "departure",
    inks.departure,
    1.6,
    "Used mostly from another package (4.2b)",
    [8, 3, 1, 3],
    {
      cue: "A notched ring on the place and a dash-dot line, so it reads without its hue",
      drawn: false,
    }
  ),
  line("hover", inks.hover, 1.6, "The island under the pointer"),
  line("coast", inks.coastPen, 2, "A package's coast"),
  line("coast-rule", inks.coastRule, 5.5, "The gilt rule inside every coast"),
  line(
    "coast-frame",
    inks.coastFrame,
    6.5,
    "The hairline framing the coast rule"
  ),
  flat("label", "text", inks.label, "A place's name"),
  flat(
    "label-caption",
    "text",
    inks.labelCaption,
    'An island\'s file count, and "no layer" where the graph could not place it'
  ),
  line("label-halo", inks.labelHalo, 3, "The paper a name is cut from"),
  flat("selected-label", "text", inks.selection, "The selected file's name"),
  line(
    "trade",
    inks.trade,
    0.9,
    "Sea trade: a package and a leading consumer",
    [8, 6],
    { units: "map" }
  ),
  line("stream", inks.stream, 1.5, "Imports between two responsibilities"),
  line("stream-bank", inks.streamBank, 6.5, "The bank either side of a stream"),
  line("stream-glint", inks.streamGlint, 2.8, "The light along a stream"),
  line(
    "marsh-drain",
    inks.marsh,
    0.8,
    "Toward a district an unresolved file could join",
    [0.7, 2.7]
  ),
  line(
    "responsibility-outline",
    districtPigment,
    0.7,
    "A responsibility's or district's footprint"
  ),
  line(
    "unresolved-outline",
    districtPigment,
    0.7,
    "A responsibility with unresolved belonging",
    [3, 3]
  ),
  line(
    "entered-outline",
    districtPigment,
    1,
    "The entered responsibility, around its files",
    [6, 3]
  ),
  flat(
    "district",
    "fill",
    districtPigment,
    "A district or responsibility, as a wash"
  ),
  line(
    "land-contour",
    inks.landContour,
    0.7,
    "Height of the high fan-in summits"
  ),
  line("sea-contour", inks.seaContour, 0.7, "Distance from the coast"),
  line("ripple", inks.ripple, 0.7, "The water lines just off a coast"),
  line("grid", inks.grid, 0.7, "The chart's grid"),
  flat("grid-reference", "text", inks.grid, "A grid reference in the margin"),
  line(
    "grid-reference-halo",
    inks.gridReferenceHalo,
    3,
    "The halo behind a grid reference"
  ),
  line("compass", inks.compass, 0.65, "The compass; it opens chart settings"),
  line(
    "latitude-scale",
    inks.scale,
    0.7,
    "The latitude scale: one tick per dependency layer"
  ),
  flat(
    "latitude-label",
    "text",
    inks.scale,
    "A dependency layer's number; the foundation is south"
  ),
  flat(
    "sea-caption",
    "text",
    inks.seaCaption,
    "The sea's name and the chart's caveat"
  ),
  flat(
    "paper",
    "fill",
    inks.paper,
    "Paper cut under a mark, or veiling a proposed position"
  ),
  line(
    "inspection-focus",
    inks.evidence,
    1,
    "Evidence in focus: a member of the selected responsibility, or a declaration a trace moves"
  ),
  line(
    "inspection-hint",
    inks.evidence,
    1,
    "A file the overlay suggests looking at",
    [1, 2]
  ),
  line(
    "inspection-proposal",
    inks.evidence,
    1,
    "Where a declaration would move",
    [2, 2]
  ),
  line(
    "scenario-proposed",
    inks.evidence,
    1.2,
    "A proposed route in a scenario",
    [3, 3]
  ),
  line(
    "scenario-baseline",
    inks.inspectionRelated,
    1.2,
    "A scenario's current route",
    [3, 3]
  ),
  line(
    "inspection-related",
    inks.inspectionRelated,
    1,
    "A file related to the selected responsibility"
  ),
  line(
    "inspection-link",
    inks.inspectionLink,
    1.2,
    "An import between evidence files",
    [3, 4]
  ),
  line(
    "inspection-notch",
    inks.inspectionWarning,
    2,
    "A file whose folder disagrees with its responsibility"
  ),
  line(
    "inspection-unresolved",
    inks.inspectionWarning,
    1.6,
    "An unresolved file in the overlay",
    [3, 2]
  ),
  line(
    "declaration",
    inks.declaration,
    1,
    "A declaration in a composition drawing"
  ),
  line(
    "declaration-blocker",
    inks.declarationBlocker,
    1,
    "A declaration that blocks the trace"
  ),
];

/** The table's row for an id; every id a painter asks for is in the table. */
export function inkStyle(id: string): InkStyle {
  const style = inkTable.find((row) => row.id === id);
  if (!style) {
    throw new Error(`The ink table has no row "${id}".`);
  }
  return style;
}

/** The ink a key swatch draws a row in: its hue, or a sample pigment for a district's rows. */
export function swatchInk(style: InkStyle): string {
  return style.hue === districtPigment
    ? districtPigments.palette[0]
    : style.hue;
}

/** A row's dash scaled to map units at a zoom, as `setLineDash` takes it. */
export function dashAt(style: InkStyle, pixels: number): number[] {
  return style.dash.map((length) => length / pixels);
}
