import { labelPriority, territoryLabelSize } from "../data/bindings";
import {
  frameOf,
  islandsByFrame,
  type SpyglassData,
  type SpyglassFile,
  type Territory,
} from "../data/types";
import { domainMark, enteredAt, inks } from "../ladder/ink-ladder";
import { fileInView } from "../view/detail-level";
import type { BelongingRegion } from "./belonging";
import { southOf } from "./domain-marks";
import { folderWithin } from "./folder-sectors";
import { cellsShown, namedFolders } from "./folders";
import { territoryLabelY } from "./geography";
import type { LabelFont, LabelInputs, MapLabel } from "./labels";

/**
 * Every label the chart proposes, kind by kind: the selected file's name,
 * the domain's name, the frames' labels, region names, folder names, then
 * each island's name with its file names. Each proposer hands what it
 * proposes to `add`; `labelCandidates` measures and lifts it.
 */

const srcPrefix = /^src\//;

/**
 * The paper halo a name is cut from, in screen pixels. Island names, their
 * captions and the domain's name sit on the sea, darker than the labels'
 * floor allows, so theirs is wide enough to fill the gaps between letters
 * and become their ground (`grounds.labelHalo`); a name on land needs only
 * a thin one. The selected file's name is cut widest.
 */
const nameHalo = { caption: 5, land: 3, sea: 6, selected: 6 } as const;

/** An island's caption under its name, in screen pixels: its size, the space between its letters, and how far below the name's baseline its own sits. */
export const islandCaption = {
  drop: 14,
  font: { face: "SpyglassBody", letterSpacing: 1.4 / 9.5 } satisfies LabelFont,
  halo: nameHalo.caption,
  ink: inks.labelCaption,
  size: 9.5,
} as const;

/** A frame's label in screen pixels: its size, the space between its letters, and its gap above the frame's northernmost names. */
const frameLabel = { gap: 18, size: 14, spacing: 3 } as const;

/** The chosen domain's name's size in screen pixels: a folder name's. */
const domainNameSize = 13;
/** How far below the middle of its piece the name's baseline sits, in its own size. */
const domainNameDrop = 1.6;
/** A folder name's size in screen pixels, under a district's. */
const folderNameSize = 13;
/** The selected file's name's size in screen pixels, and how far above its mark its baseline sits. */
const selectedFileName = { lift: 21, size: 20 } as const;
/** A file's name's size in screen pixels, larger when the belonging layer lists files, and its lift above the mark. */
const fileName = { lift: 7, listed: 17, size: 15 } as const;
/** A region's name's size in screen pixels. */
const regionNameSize = 15;
/** An island's name on screen, in pixels: its bounds at any zoom, and the size below which it is left out. */
const islandName = { least: 9, max: 26, min: 12 } as const;

const display: LabelFont = { face: "SpyglassDisplay", letterSpacing: 0 };
const body: LabelFont = { face: "SpyglassBody", letterSpacing: 0 };
const italicBody: LabelFont = {
  face: "SpyglassBody",
  italic: true,
  letterSpacing: 0,
};
const georgia: LabelFont = { face: "Georgia", letterSpacing: 0 };
const spacedCapitals: LabelFont = {
  face: "SpyglassBody",
  letterSpacing: frameLabel.spacing / frameLabel.size,
};

/** `Omit` over each member of a union, not over what the members share. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** A label as proposed: everything but its width, which the measure gives, its lift, which the relief gives, and its opacity, full unless it fades. */
export type Proposal = DistributiveOmit<MapLabel, "opacity" | "width" | "z"> & {
  opacity?: number;
};

/** What the proposers share: the inputs, and where a proposal goes. */
export interface Proposer {
  add: (proposal: Proposal) => void;
  inputs: LabelInputs;
  pixels: number;
}

/** The middle of some points; the origin for none. */
function centroid(points: readonly { x: number; y: number }[]): {
  x: number;
  y: number;
} {
  const count = Math.max(1, points.length);
  let x = 0;
  let y = 0;
  for (const point of points) {
    x += point.x;
    y += point.y;
  }
  return { x: x / count, y: y / count };
}

/** The name of a file, in its path. */
const nameOf = (file: SpyglassFile) => file.path.split("/").at(-1) ?? file.path;

/** The selected file's name, first: it wins every collision. */
export function addSelectedFileName(
  { add, inputs, pixels }: Proposer,
  territories: Territory[]
) {
  const { detail, fileId } = inputs;
  if (detail.files + detail.composition <= 0.1) {
    return;
  }
  for (const p of territories) {
    const file = p.files.find((f) => f.id === fileId);
    if (file) {
      add({
        font: body,
        halo: nameHalo.selected,
        height: selectedFileName.size / pixels,
        ink: inks.selection,
        kind: "file",
        opacity: Math.max(detail.files, detail.composition),
        place: { file, territory: p },
        territory: p,
        text: nameOf(file),
        x: p.x + file.x,
        y: p.y + file.y - selectedFileName.lift / pixels,
      });
    }
  }
}

/**
 * The chosen domain's name, once, at the largest piece of it in view:
 * "domain node-runtime" just above the diamond of an island it covers
 * whole, clear of a package's departure ring at its middle; or just below
 * the middle of the files of the cells it covers on one, clear of the
 * folder's name a line above and of a bead at the middle. It comes after
 * only the selected file's name, so it wins every other collision. None
 * when no piece is in view.
 */
export function addDomainLabel({ add, inputs, pixels }: Proposer) {
  const { belonging, domain, view } = inputs;
  if (!domain) {
    return;
  }
  const size = domainNameSize / pixels;
  const pieces = domain.islands.flatMap((island) => {
    const { territory } = island;
    if (island.whole) {
      const [x, south] = southOf(territory);
      const above = (domainMark.inset + domainMark.diamond + 3) / pixels;
      return [{ covered: island.covered, territory, x, y: south - above }];
    }
    if (!(island.covered && cellsShown(territory, belonging))) {
      return [];
    }
    const inside = new Set(island.files);
    for (const cell of island.cells) {
      const path = [territory.folder, cell.folder].filter(Boolean).join("/");
      for (const file of territory.files) {
        if (file.path.startsWith(`${path}/`)) {
          inside.add(file);
        }
      }
    }
    const { x, y } = centroid([...inside]);
    return [
      { covered: island.covered, territory, x, y: y + domainNameDrop * size },
    ];
  });
  const shown = pieces
    .map((piece) => ({
      ...piece,
      x: piece.territory.x + piece.x,
      y: piece.territory.y + piece.y,
    }))
    .filter(
      (piece) =>
        Math.abs(piece.x - view.x) <= view.width / 2 &&
        Math.abs(piece.y - view.y) <= view.height / 2
    )
    .sort((a, b) => b.covered - a.covered);
  const [largest] = shown;
  if (!largest) {
    return;
  }
  add({
    font: body,
    halo: nameHalo.sea,
    height: size,
    ink: inks.domainName,
    kind: "domain",
    territory: largest.territory,
    text: `domain ${domain.name}`,
    x: largest.x,
    y: largest.y,
  });
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
 * island of the same name: its frame's label, " · PLATFORM", so the two read
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
        ? [
            [
              territory.id,
              ` · ${frameOf(data, territory.id).label.toUpperCase()}`,
            ],
          ]
        : []
    )
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
 * Each island's first branching folder's subfolders, named below it with a
 * trailing slash ("web/" in `src`) at the centroid of their cells, from
 * island zoom: after the districts' names, so a district wins a collision,
 * and before the island's and the files'. None on an island "Group files
 * by responsibility" has rearranged.
 */
export function addFolderLabels(
  { add, inputs, pixels }: Proposer,
  territories: Territory[]
) {
  const { belonging, data } = inputs;
  if (pixels < enteredAt) {
    return;
  }
  const size = folderNameSize / pixels;
  for (const territory of territories) {
    const tree = data.folderCells[territory.id];
    if (!(tree && cellsShown(territory, belonging))) {
      continue;
    }
    for (const { cell, name } of namedFolders(tree)) {
      const { x, y } = centroid(cell.sites);
      // Set a line above the centroid, where a proximity tie ends in a bead.
      add({
        font: italicBody,
        halo: nameHalo.land,
        height: size,
        ink: inks.folder,
        kind: "folder",
        place: { territory },
        territory,
        text: `${name}/`,
        x: territory.x + x,
        y: territory.y + y - size,
      });
    }
  }
}

/**
 * Each island's name, with its file count as a caption, then, on the
 * selected or belonging island at close zoom, its file names.
 */
export function addTerritoryLabels(
  proposer: Proposer,
  territories: Territory[]
) {
  const { add, inputs, pixels } = proposer;
  const { belonging, data, detail, fileId, selected, view } = inputs;
  const unplaced = new Set(
    Object.entries(data.packageLayers).flatMap(([id, layer]) =>
      layer === null ? [id] : []
    )
  );
  const notes = frameNotes(data);
  for (const p of territories) {
    const size = territoryNameSize(p, pixels);
    if (size * pixels >= islandName.least) {
      const count = p.files.length;
      add({
        // A package the graph could not place sits at the foundation, off the
        // latitude scale; its caption says so. In a collection, a name two
        // frames share takes its frame's label.
        caption: `${count.toLocaleString("en")} ${count === 1 ? "FILE" : "FILES"}${unplaced.has(p.id) ? " · NO LAYER" : ""}${notes.get(p.id) ?? ""}`,
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
    if (p.id !== selected && p.id !== belonging?.territory.id) {
      continue;
    }
    if (
      pixels < 5 ||
      detail.files < 0.5 ||
      fileInView(p, fileId ?? undefined, view)
    ) {
      continue;
    }
    addFileLabels(proposer, p);
  }
}

/**
 * An island's file names, most connected first, each a little above its
 * mark: on a belonging island only the layer's files and the overlay's
 * evidence; with evidence, only the evidence.
 */
function addFileLabels({ add, inputs, pixels }: Proposer, p: Territory) {
  const { belonging, detail, evidenceFiles, fileId } = inputs;
  const size = (belonging?.files ? fileName.listed : fileName.size) / pixels;
  for (const f of [...p.files].sort(
    (a, b) =>
      labelPriority(b.incoming, b.outgoing) -
        labelPriority(a.incoming, a.outgoing) || a.id.localeCompare(b.id)
  )) {
    if (f.id === fileId) {
      continue;
    }
    if (
      p.id === belonging?.territory.id &&
      belonging.files &&
      !belonging.files.some((member) => member.id === f.id) &&
      !evidenceFiles?.has(f.id)
    ) {
      continue;
    }
    if (evidenceFiles?.size && !evidenceFiles.has(f.id)) {
      continue;
    }
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
      x: p.x + f.x,
      y: p.y + f.y - fileName.lift / pixels,
    });
  }
}

/**
 * Whether a district's name, at its anchor file, is the name of the folder
 * it sits in: such a district leaves its name to the folder, since Place and
 * the panel still name it.
 */
function namesItsFolder(
  inputs: LabelInputs,
  territory: Territory,
  file: SpyglassFile,
  text: string
): boolean {
  const { belonging, data, view } = inputs;
  const tree = data.folderCells[territory.id];
  if (
    !(
      tree &&
      view.pixelsPerUnit >= enteredAt &&
      cellsShown(territory, belonging)
    )
  ) {
    return false;
  }
  const within = folderWithin(file.directory, territory.folder);
  return namedFolders(tree).some(
    ({ cell, name }) =>
      (within === cell.folder || within.startsWith(`${cell.folder}/`)) &&
      (text === name || text === cell.folder)
  );
}

/** How far above its anchor a region's name sits, in screen pixels: clear of the files or the composition an entered parent shows. */
function regionLabelLift(
  parent: boolean | undefined,
  region: BelongingRegion,
  inputs: LabelInputs
): number {
  const { belonging, composition } = inputs;
  return parent && !region.children && (composition || belonging?.files)
    ? 36
    : 8;
}

/**
 * The belonging layer's region names, parents first, then regions, larger
 * first: each at its anchor member (or the member nearest its middle), in
 * Georgia, fading with the districts; a parent keeps a floor of 0.2 while
 * its group is entered. A collection's groups and a region named as its
 * folder are left out, and so is every region but the parents once a
 * composition takes over.
 */
export function addRegionLabels({ add, inputs, pixels }: Proposer) {
  const { belonging, detail } = inputs;
  if (!belonging) {
    return;
  }
  const regions = [...(belonging.parents ?? []), ...belonging.regions].sort(
    (a, b) =>
      Number(belonging.parents?.includes(b)) -
        Number(belonging.parents?.includes(a)) ||
      Number(belonging.regions.includes(b)) -
        Number(belonging.regions.includes(a)) ||
      b.members.length - a.members.length
  );
  for (const region of regions) {
    const parent = belonging.parents?.includes(region);
    const regionStrength = Math.max(detail.districts, parent ? 0.2 : 0);
    if (
      !region.label ||
      region.collection ||
      regionStrength < 0.05 ||
      (!parent && detail.composition >= 0.5)
    ) {
      continue;
    }
    const anchor = regionAnchor(region);
    const text = region.label.replace(srcPrefix, "");
    if (!anchor || namesItsFolder(inputs, belonging.territory, anchor, text)) {
      continue;
    }
    const { territory } = belonging;
    add({
      font: georgia,
      halo: nameHalo.land,
      height: regionNameSize / pixels,
      ink: inks.label,
      kind: "region",
      opacity: (parent ? 1 : (belonging.reveal ?? 1)) * regionStrength,
      place: region.children
        ? { compositeId: region.id, territory }
        : { regionId: region.id, territory },
      territory,
      text,
      x: territory.x + anchor.x,
      y:
        territory.y +
        anchor.y -
        regionLabelLift(parent, region, inputs) / pixels,
    });
  }
}

/** The member a region's name sits at: its anchor, or the member nearest its middle. */
function regionAnchor(region: BelongingRegion): SpyglassFile | undefined {
  if (region.anchor) {
    return region.anchor;
  }
  const center = centroid(region.members);
  return [...region.members].sort(
    (a, b) =>
      Math.hypot(a.x - center.x, a.y - center.y) -
      Math.hypot(b.x - center.x, b.y - center.y)
  )[0];
}
