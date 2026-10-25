import { districtPigment, districtPigments, inks } from "./ink-ladder";

/**
 * The ink table: the hue × dash × weight rows of the map key, each row the
 * meaning of one line, mark, fill or text, and the typed lookup a painter
 * names its ink by. The palette and the ladder's rungs are in
 * `ink-ladder.ts`; this is the key read from them.
 */

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

/** A row whose id the type remembers, so the table's ids make `InkId`. */
type InkRow<Id extends string> = InkStyle & { id: Id };

const line = <Id extends string>(
  id: Id,
  hue: string,
  weight: number,
  meaning: string,
  dash: Dash = [],
  extra: Partial<Pick<InkStyle, "cue" | "units">> = {}
): InkRow<Id> => ({
  dash,
  hue,
  id,
  kind: "line",
  meaning,
  weight,
  ...extra,
});

const flat = <Id extends string>(
  id: Id,
  kind: "fill" | "text",
  hue: string,
  meaning: string
): InkRow<Id> => ({ dash: [], hue, id, kind, meaning, weight: 0 });

/**
 * Every line, mark, fill and text a reader's map can show, by hue, dash and
 * weight. No two rows of one kind share all three, so no two meanings look
 * alike; the map key reads its rows from here. The rows are a tuple, so a
 * painter's ink id is checked where it is written (`InkId`).
 */
export const inkTable = [
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
  flat(
    "grid-reference",
    "text",
    inks.gridReference,
    "A grid reference in the margin"
  ),
  line(
    "grid-reference-halo",
    inks.gridReferenceHalo,
    3,
    "The halo behind a grid reference"
  ),
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
] as const satisfies readonly InkStyle[];

/** The id of a row of the ink table: what a painter names its ink by. */
export type InkId = (typeof inkTable)[number]["id"];

const inkRows = new Map<InkId, InkStyle>(inkTable.map((row) => [row.id, row]));

/** The table's row for an id. The ids are typed, so a miss is a row removed after a painter was written. */
export function inkStyle(id: InkId): InkStyle {
  const style = inkRows.get(id);
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
