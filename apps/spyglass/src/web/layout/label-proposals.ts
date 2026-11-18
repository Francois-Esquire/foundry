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

const nameHalo = { caption: 5, land: 3, sea: 6, selected: 6 } as const;

export const islandCaption = {
  countFrom: 2,
  drop: 14,
  font: { face: "SpyglassBody", letterSpacing: 1.4 / 9.5 } satisfies LabelFont,
  halo: nameHalo.caption,
  ink: inks.labelCaption,
  size: 9.5,
} as const;

const frameLabel = { gap: 18, size: 14, spacing: 3 } as const;

const selectedFileName = { lift: 21, size: 20 } as const;
const fileName = { lift: 7, size: 15 } as const;
const nameAboveCoast = 17;
const islandName = { least: 9, max: 26, min: 12 } as const;

const display: LabelFont = { face: "SpyglassDisplay", letterSpacing: 0 };
const body: LabelFont = { face: "SpyglassBody", letterSpacing: 0 };
const spacedCapitals: LabelFont = {
  face: "SpyglassBody",
  letterSpacing: frameLabel.spacing / frameLabel.size,
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

type Proposal = DistributiveOmit<MapLabel, "opacity" | "width" | "z"> & {
  opacity?: number;
};

export interface Proposer {
  add: (proposal: Proposal) => void;
  inputs: LabelInputs;
  pixels: number;
}

const nameOf = (file: SpyglassFile) => file.path.split("/").at(-1) ?? file.path;

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

function territoryLabelY(territory: Territory): number {
  return (
    Math.min(
      0,
      ...territory.coast.flatMap((p) => p[0]?.map((point) => point[1]) ?? [])
    ) - nameAboveCoast
  );
}

function territoryNameSize(territory: Territory, pixels: number): number {
  return Math.min(
    islandName.max / pixels,
    Math.max(islandName.min / pixels, territoryLabelSize(territory.radius))
  );
}

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
