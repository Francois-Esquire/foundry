import { chartGrid } from "../data/bindings";
import { detailLevel } from "../view/detail-level";

/**
 * The ink ladder: how strongly each kind of mark is drawn, as luminance
 * contrast against the ground it sits on, and the one table of hue, dash and
 * weight that says what each line or mark means. Every colour the chart
 * scene uses is here and nowhere under `scene/`; painters take their
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
  /**
   * The paper a name on the sea is cut from: island names, their captions
   * and a domain's name take a halo wide enough to be their ground there
   * (`nameHalo` in `layout/label-candidates.ts`).
   */
  labelHalo: "#f5efdf",
  land: "#f1ead9",
  /**
   * The ocean blue at the chart's edge, the darkest water there is: a
   * crossing runs beyond the rims, between the frames, so it is measured
   * here, wherever the open water it crosses steps to.
   */
  openWater: "#b4c4c5",
  /**
   * The darkest sea a line crosses at the named zooms, probed on screen
   * between the rows at overview (4.2b): the sea marks are measured on it,
   * so that a line meets its rung wherever it runs.
   */
  sea: "#c8d1c3",
  shallows: "#e3e6d7",
  shoreWater: "#dfe3d3",
  /**
   * The foam of the surf along an archipelago's rim (`scene/weather.ts`): the
   * lightest water, which the deep water is mixed toward at the crest of a
   * wave; the sea marks that cross a rim are measured on it like any ground.
   */
  surf: "#eef1e6",
} as const;
type Ground = "land" | "labelHalo" | "openWater" | "sea";

/** The original island pigment washes, underneath the shared warm paper. */
export const packagePigments = [
  "#efcf88",
  "#b4d5a5",
  "#edb59d",
  "#a3d6bc",
  "#ead6a5",
  "#cab6df",
  "#d6dda0",
] as const;

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

/**
 * Each rung's least contrast with its ground (the WCAG ratio, 1 to 21). A
 * mark on a rung meets its rung's floor and stays under the floor of the rung
 * above, so no mark outranks one that matters more.
 */
export const rungFloor: Record<Rung, number> = {
  /** The lines between an island's folders: under every tie, over the coast. */
  cell: 3,
  coast: 1.8,
  /** A collection's crossings between workspaces: under every departure, over every file mark. */
  crossing: 6,
  departure: 8,
  /** A chosen domain's outline and marks: under every name, over every tie. */
  domain: 4,
  file: 5.5,
  label: 4.5,
  relief: 1.25,
  // Sea lines fade in with zoom, so the sea rung has no floor of its own.
  sea: 1,
  selection: 10,
  /** Proximity's ties and marks at island zoom: read after every name, before the coast. */
  tie: 3.5,
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
  /**
   * A crossing between two workspaces of a collection: a deep violet no other
   * ink takes, kept 10 ΔE76 from every ink a sea line sits beside, in every
   * vision.
   */
  crossing: "#580490",
  /** A declaration in a composition drawing, and one that blocks a trace. */
  declaration: "#4a4233",
  declarationBlocker: "#963f32",
  /** Departures: magenta, with a notched ring and a dash-dot line as a second cue. */
  departure: "#681049",
  /** A departure's line, darker than its ring, since the sea it crosses is darker than the land the ring sits on. */
  departureLine: "#5e0d42",
  /**
   * A chosen domain: its outline, the files and packages it covers, and the
   * departures it explains, in a cobalt no other ink takes; its name in a
   * darker ink of the same hue, on the label rung.
   */
  domain: "#1e6ccc",
  domainName: "#125ecc",
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
  /**
   * Folders inside an island: a name in italics on the label rung, and the
   * cuts between sibling folders, lighter, of the same violet-grey, a hue no
   * label or district takes.
   */
  folder: "#5f5980",
  folderLine: "#8975a3",
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
  labelHalo: grounds.labelHalo,
  /** Height contours over the land and distance rings on the sea. */
  landContour: "#806c4f",
  marsh: "#697855",
  /** Paper itself, where a mark is cut from what is under it. */
  paper: "#f1ead9",
  /**
   * Proximity, at island zoom: what sits related but apart, and close but
   * unrelated. A slate on the tie rung, the hue left between test's and
   * story's, kept 10 ΔE76 from every other ink in every vision.
   */
  proximity: "#6b70b8",
  /** Barely-there gilt water lines near each coast. */
  ripple: "#a8873c",
  /** The latitude scale in the right margin: dependency layers, foundation to the south. */
  scale: "#57523f",
  /** The sea's name and the chart's caveat. */
  seaCaption: "#64786b",
  seaContour: "#487f78",
  /** The selection: an island's ring at overview and its lines, a file's ring and name, a feature's outline. */
  selection: "#361b05",
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
  ripple: [0.16, 0.11, 0.07] as const,
  /** Ripples surface as the camera comes in. */
  rippleReveal: (pixels: number) =>
    Math.max(0, Math.min(1, (pixels - 0.9) / 1.4)),
  scenarioBaseline: 0.5,
  seaContourMajor: 0.18,
  seaContourMinor: 0.12,
  streamBank: 0.12,
  streamGlint: 0.75,
  /** Valley darkening on lit paper; slope lighting and screen occlusion are separate. */
  valleyShade: 0.24,
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
 * hovered, no overlay receding the other files. Optional layers and on-demand ink (trade
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
  // Names on the sea are read against their halo, which fills their letters' gaps.
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
    // Vertex valley shading alone, before lighting and screen occlusion.
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

/**
 * A departure's mark: a ring, its radius in screen pixels by what departs,
 * with a notch at the top, in radians, its second cue beside the hue.
 */
export const departureRing = {
  notch: Math.PI / 3,
  radius: { file: 4, folder: 5.5, package: 9 },
} as const;

/**
 * A close-but-unrelated folder's mark, in screen pixels: two arcs, "( )",
 * each pushed `apart` from the centre, sweeping `sweep` radians either side
 * of the horizontal, so it reads as two sides apart; the departure's ring is
 * one ring with one notch.
 */
export const closeMark = {
  apart: 2,
  radius: 5,
  sweep: (55 * Math.PI) / 180,
} as const;

/**
 * A chosen domain's marks, in screen pixels: the square round a file it
 * names, half its side, wide enough to hold a departing file's ring; the
 * diamond inside the coast of a package it covers whole, half its diagonal,
 * held `inset` in from the coast's southern point.
 */
export const domainMark = {
  diamond: 5,
  fileSquare: 6.5,
  inset: 9,
} as const;

/** A line's dash in screen pixels; empty is solid. */
type Dash = readonly number[];

/** One row of the hue × dash × weight table: what a line or mark means. */
export interface InkStyle {
  /** A second cue beside the hue, for readers who cannot tell the hue apart. */
  cue?: string;
  dash: Dash;
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
): InkStyle => ({ dash: [], hue, id, kind, meaning, weight: 0 });

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
    "departure-bead",
    "fill",
    inks.departureLine,
    "The end of a departure line: the package that uses the place most"
  ),
  flat(
    "proximity-bead",
    "fill",
    inks.proximity,
    "The end of a proximity tie: a folder, or a file that changes with another"
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
    "Used mostly from another package",
    [],
    {
      cue: "A notched ring on the place, so it reads without its hue",
    }
  ),
  line(
    "departure-line",
    inks.departureLine,
    1.6,
    "Toward the package that uses it most",
    [8, 3, 1, 3],
    { cue: "A dash-dot line, so it reads without its hue" }
  ),
  line(
    "crossing",
    inks.crossing,
    2,
    "A declared dependency on a package of another workspace",
    [10, 4],
    { cue: "Long dashes, ending in a bead at the package depended on" }
  ),
  flat(
    "crossing-bead",
    "fill",
    inks.crossing,
    "The end of a crossing: the package depended on"
  ),
  line(
    "domain-outline",
    inks.domain,
    2.5,
    "Where the chosen domain lies: the folders it covers, or a whole package's coast",
    [6, 3],
    { cue: "Dashed, inside the edge of what it covers" }
  ),
  line(
    "domain-file",
    inks.domain,
    2.5,
    "A file the chosen domain names, in a square"
  ),
  flat(
    "domain-package",
    "fill",
    inks.domain,
    "A package the chosen domain covers whole: a diamond inside its coast"
  ),
  line(
    "domain-explained",
    inks.domain,
    3.5,
    "A departure the chosen domain explains: every consumer elsewhere shares it",
    [],
    { cue: "It closes the departure ring's notch" }
  ),
  flat(
    "domain-name",
    "text",
    inks.domainName,
    "The chosen domain's name, once"
  ),
  line(
    "folder-cell",
    inks.folderLine,
    2,
    "A cut between an island's sibling folders"
  ),
  line(
    "proximity-apart",
    inks.proximity,
    1.5,
    "A file apart from its responsibility's folder, tied to it",
    [1, 3],
    { cue: "Dotted, ending in a bead at the folder" }
  ),
  line(
    "proximity-co-change",
    inks.proximity,
    1.5,
    "Two files in different folders that change together",
    [4, 3],
    { cue: "Dashed, a bead at each file" }
  ),
  line(
    "proximity-close",
    inks.proximity,
    1.2,
    "A folder whose files serve unrelated responsibilities",
    [],
    { cue: "Two arcs set apart, ( ), one for each side" }
  ),
  line("hover", inks.hover, 1.6, "The island under the pointer"),
  line("coast", inks.coastPen, 1, "A package's coast"),
  line("coast-rule", inks.coastRule, 2.75, "The gilt rule along every coast"),
  line(
    "coast-frame",
    inks.coastFrame,
    3.35,
    "The hairline framing the coast rule"
  ),
  flat(
    "label",
    "text",
    inks.label,
    "A place's name: an island's, or a workspace's above its frame"
  ),
  flat(
    "folder-name",
    "text",
    inks.folder,
    "A folder's name, in italics and ending in a slash"
  ),
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
