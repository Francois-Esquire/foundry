import { labelPriority, territoryLabelSize } from "../data/bindings";
import {
  frameOf,
  islandsByFrame,
  type SpyglassData,
  type SpyglassFile,
  type Territory,
} from "../data/types";
import { inks } from "../ladder/ink-ladder";
import { fileInView } from "../view/detail-level";
import { filePlace } from "../view/file-place";
import type { LabelFont, LabelInputs, MapLabel } from "./labels";

/**
 * Every label the chart proposes, kind by kind: the selected file's name,
 * the frames' labels, then each island's name with its file names. Each
 * proposer hands what it proposes to `add`; `labelCandidates` measures it.
 */

/**
 * The paper halo a name is cut from, in screen pixels. Island names and
 * their captions sit on the sea, darker than the labels'
 * floor allows, so theirs is wide enough to fill the gaps between letters
 * and become their ground (`grounds.labelHalo`); a name on land needs only
 * a thin one. The selected file's name is cut widest.
 */
const nameHalo = { caption: 5, land: 3, sea: 6, selected: 6 } as const;

/**
 * An island's caption under its name, in screen pixels: its size, the space
 * between its letters, and how far below the name's baseline its own sits.
 * The file count joins it only from `countFrom` pixels per chart unit, well
 * into an island, so the overview reads as names alone and no count covers
 * a neighbouring island.
 */
export const islandCaption = {
  countFrom: 2,
  drop: 14,
  font: { face: "SpyglassBody", letterSpacing: 1.4 / 9.5 } satisfies LabelFont,
  halo: nameHalo.caption,
  ink: inks.labelCaption,
  size: 9.5,
} as const;

/** A frame's label in screen pixels: its size, the space between its letters, and its gap above the frame's northernmost names. */
const frameLabel = { gap: 18, size: 14, spacing: 3 } as const;

/** The selected file's name's size in screen pixels, and how far above its mark its baseline sits. */
const selectedFileName = { lift: 21, size: 20 } as const;
/** A file's name's size in screen pixels, and its lift above the mark. */
const fileName = { lift: 7, size: 15 } as const;
/** How far north of an island's coast its name's baseline sits, chart units. */
const nameAboveCoast = 17;
/** An island's name on screen, in pixels: its bounds at any zoom, and the size below which it is left out. */
const islandName = { least: 9, max: 26, min: 12 } as const;

const display: LabelFont = { face: "SpyglassDisplay", letterSpacing: 0 };
const body: LabelFont = { face: "SpyglassBody", letterSpacing: 0 };
const spacedCapitals: LabelFont = {
  face: "SpyglassBody",
  letterSpacing: frameLabel.spacing / frameLabel.size,
};

/** `Omit` over each member of a union, not over what the members share. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** A label as proposed: everything but its width, which the measure gives, its anchor's height, and its opacity, full unless it fades. */
type Proposal = DistributiveOmit<MapLabel, "opacity" | "width" | "z"> & {
  opacity?: number;
};

/** What the proposers share: the inputs, and where a proposal goes. */
export interface Proposer {
  add: (proposal: Proposal) => void;
  inputs: LabelInputs;
  pixels: number;
}

/** The name of a file, in its path. */
const nameOf = (file: SpyglassFile) => file.path.split("/").at(-1) ?? file.path;

/** The selected file's name, first: it wins every collision. */
export function addSelectedFileName(
  { add, inputs, pixels }: Proposer,
  territories: Territory[]
) {
  const { detail, fileAt, fileId } = inputs;
  if (detail.files <= 0.1) {
    return;
  }
  for (const p of territories) {
    const file = p.files.find((f) => f.id === fileId);
    if (file) {
      const at = filePlace(p, file, fileAt);
      add({
        font: body,
        halo: nameHalo.selected,
        height: selectedFileName.size / pixels,
        ink: inks.selection,
        kind: "file",
        opacity: detail.files,
        place: { file, territory: p },
        territory: p,
        text: nameOf(file),
        x: at.x,
        y: at.y - selectedFileName.lift / pixels,
      });
    }
  }
}

/**
 * Each frame's label in a collection, above the frame: in spaced capitals,
 * centred over its islands, a gap above the tallest of its northernmost
 * names. Set in the place-name ink, on the sea's halo. It names no island: a
 * click passes through it. A single workspace has none.
 */
export function addFrameLabels({ add, inputs, pixels }: Proposer) {
  const { data } = inputs;
  if (data.frames.length <= 1) {
    return;
  }
  const size = frameLabel.size / pixels;
  const gap = frameLabel.gap / pixels;
  for (const [i, islands] of islandsByFrame(data).entries()) {
    const frame = data.frames[i];
    if (!(islands.length && frame)) {
      continue;
    }
    const text = frame.label.toUpperCase();
    const west = Math.min(...islands.map((p) => p.x - p.radius));
    const east = Math.max(...islands.map((p) => p.x + p.radius));
    const y =
      Math.min(
        ...islands.map(
          (p) => p.y + territoryLabelY(p) - territoryNameSize(p, pixels)
        )
      ) - gap;
    const centred = (west + east) / 2;
    add({
      font: spacedCapitals,
      frame,
      halo: nameHalo.sea,
      height: size,
      ink: inks.label,
      kind: "frame",
      text,
      x: centred,
      y,
    });
  }
}

/**
 * In a collection, what an island's caption adds where another frame has an
 * island of the same name: its frame's label, "PLATFORM", so the two read
 * apart on the map. Nothing for a single workspace, or a name only one
 * frame has.
 */
function frameNotes(data: SpyglassData): ReadonlyMap<string, string> {
  if (data.frames.length <= 1) {
    return new Map();
  }
  const frames = new Map<string, Set<string>>();
  for (const territory of data.territories) {
    const holding = frames.get(territory.label) ?? new Set<string>();
    holding.add(frameOf(data, territory.id).id);
    frames.set(territory.label, holding);
  }
  return new Map(
    data.territories.flatMap((territory) =>
      (frames.get(territory.label)?.size ?? 0) > 1
        ? [[territory.id, frameOf(data, territory.id).label.toUpperCase()]]
        : []
    )
  );
}

/**
 * Where an island's name sits, from its middle: a little north of its
 * northernmost coast, or of its middle for an island without one.
 */
function territoryLabelY(territory: Territory): number {
  return (
    Math.min(
      0,
      ...territory.coast.flatMap((p) => p[0]?.map((point) => point[1]) ?? [])
    ) - nameAboveCoast
  );
}

/** An island's name's size in map units at a zoom: bounded on screen, between 12 and 26 pixels. */
function territoryNameSize(territory: Territory, pixels: number): number {
  return Math.min(
    islandName.max / pixels,
    Math.max(islandName.min / pixels, territoryLabelSize(territory.radius))
  );
}

/**
 * Each island's name, with a caption beneath once zoomed in close: its file
 * count. What tells the island apart (no layer, or its frame where two
 * frames share the name) shows at every zoom. Then, on the selected island
 * at close zoom, its file names.
 */
export function addTerritoryLabels(
  proposer: Proposer,
  territories: Territory[]
) {
  const { add, inputs, pixels } = proposer;
  const { data, detail, fileId, selected, view } = inputs;
  const unplaced = new Set(
    Object.entries(data.packageLayers).flatMap(([id, layer]) =>
      layer === null ? [id] : []
    )
  );
  const notes = frameNotes(data);
  for (const p of territories) {
    const size = territoryNameSize(p, pixels);
    if (size * pixels >= islandName.least) {
      add({
        caption: islandCaptionText(p, pixels, unplaced.has(p.id), notes),
        font: display,
        halo: nameHalo.sea,
        height: size,
        ink: inks.label,
        kind: "island",
        place: { territory: p },
        territory: p,
        text: p.label,
        x: p.x,
        y: p.y + territoryLabelY(p),
      });
    }
    if (p.id !== selected) {
      continue;
    }
    if (
      pixels < 5 ||
      detail.files < 0.5 ||
      fileInView(p, fileId ?? undefined, view, inputs.fileAt)
    ) {
      continue;
    }
    addFileLabels(proposer, p);
  }
}

/**
 * An island's caption: its file count once zoomed in close, then the notes
 * that tell it apart. A package the graph could not place sits at the
 * foundation, off the latitude scale; its caption says so. In a collection,
 * a name two frames share takes its frame's label. Empty when there is
 * nothing to say.
 */
function islandCaptionText(
  p: Territory,
  pixels: number,
  unplaced: boolean,
  notes: ReadonlyMap<string, string>
): string {
  const count = p.files.length;
  const parts = [
    pixels >= islandCaption.countFrom
      ? `${count.toLocaleString("en")} ${count === 1 ? "FILE" : "FILES"}`
      : undefined,
    unplaced ? "NO LAYER" : undefined,
    notes.get(p.id),
  ];
  return parts.filter((part) => part !== undefined).join(" · ");
}

/** An island's file names, most connected first, each a little above its mark. */
function addFileLabels({ add, inputs, pixels }: Proposer, p: Territory) {
  const { detail, fileAt, fileId } = inputs;
  const size = fileName.size / pixels;
  for (const f of [...p.files].sort(
    (a, b) =>
      labelPriority(b.incoming, b.outgoing) -
        labelPriority(a.incoming, a.outgoing) || a.id.localeCompare(b.id)
  )) {
    if (f.id === fileId) {
      continue;
    }
    const at = filePlace(p, f, fileAt);
    add({
      font: body,
      halo: nameHalo.land,
      height: size,
      ink: inks.label,
      kind: "file",
      opacity: detail.files,
      place: { file: f, territory: p },
      territory: p,
      text: nameOf(f),
      x: at.x,
      y: at.y - fileName.lift / pixels,
    });
  }
}
