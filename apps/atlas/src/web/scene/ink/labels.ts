import type { BelongingLayer, BelongingRegion } from "../../belonging";
import { labelPriority, territoryLabelSize } from "../../codex/bindings";
import type { CompositionMark } from "../../composition-layout";
import { folderWithin } from "../../folder-sectors";
import { territoryLabelY } from "../../geography";
import type { ResponsibilityOverlay } from "../../responsibility-focus";
import type { AtlasData, AtlasFile, Territory } from "../../types";
import { detailLevel, fileInView } from "../detail-level";
import type { InkView, MapLabel } from "../exploration";
import { visibleLabels } from "../exploration";
import { enteredAt, inks } from "../ink-ladder";
import { cellsShown, namedFolders } from "./folders";
import type { InkState } from "./state";

const paintLabelsPattern = /^src\//;

/** Whether a district's name, at its anchor file, is the name of the folder it sits in. */
type FolderNamed = (
  territory: Territory,
  file: AtlasFile,
  text: string
) => boolean;

/** Island, region and file names within their budgets; the placed labels go on the state. */
export function paintMapLabels(state: InkState): void {
  const { activeRegion, data, view } = state;
  state.labels = paintLabels(
    state.labelContext,
    data,
    state.selected,
    state.fileId,
    view ?? {
      height: data.height,
      pixelsPerUnit: 1,
      width: data.width,
      x: 0,
      y: 0,
    },
    state.detail,
    state.evidenceFiles ??
      (activeRegion
        ? new Set(activeRegion.members.map((file) => file.id))
        : undefined),
    state.responsibility?.composition,
    state.belonging,
    state.project
  );
}

function paintLabels(
  ctx: CanvasRenderingContext2D,
  data: AtlasData,
  selected: string | null,
  fileId: string | null,
  view: InkView,
  detail: {
    composition: number;
    districts: number;
    files: number;
    specks: number;
  } = detailLevel(view.pixelsPerUnit),
  evidenceFiles?: Set<string>,
  composition?: ResponsibilityOverlay["composition"],
  belonging?: BelongingLayer | null,
  project: (label: MapLabel) => MapLabel = (label) => label
): MapLabel[] {
  const candidates: MapLabel[] = [];
  const add = (
    territory: Territory,
    text: string,
    x: number,
    y: number,
    size: number,
    face: string,
    extra: Partial<MapLabel> = {}
  ) => {
    const font = `${size}px ${face}`;
    ctx.font = font;
    candidates.push({
      font,
      height: size,
      territory,
      text,
      width: ctx.measureText(text).width,
      x,
      y,
      ...extra,
    });
  };
  const pixels = view.pixelsPerUnit;

  const territories = [...data.territories].sort(
    (a, b) =>
      Number(b.id === selected) - Number(a.id === selected) ||
      b.files.length - a.files.length
  );
  for (const p of territories) {
    const file = p.files.find((f) => f.id === fileId);
    if (file && detail.files + detail.composition > 0.1) {
      add(
        p,
        file.path.split("/").at(-1) ?? file.path,
        p.x + file.x,
        p.y + file.y - 21 / pixels,
        20 / pixels,
        "AtlasBody",
        { file, opacity: Math.max(detail.files, detail.composition) }
      );
    }
  }
  // A district named as the folder it sits in leaves the name to the folder;
  // Place and the panel still name the district.
  const namesItsFolder = (
    territory: Territory,
    file: AtlasFile,
    text: string
  ) => {
    const tree = data.folderCells[territory.id];
    if (!(tree && pixels >= enteredAt && cellsShown(territory, belonging))) {
      return false;
    }
    const within = folderWithin(file.directory, territory.folder);
    return namedFolders(tree).some(
      ({ cell, name }) =>
        (within === cell.folder || within.startsWith(`${cell.folder}/`)) &&
        (text === name || text === cell.folder)
    );
  };
  addRegionLabels(belonging, detail, add, composition, pixels, namesItsFolder);
  addFolderLabels(data, territories, belonging, add, pixels);
  addTerritoryLabels(
    territories,
    pixels,
    add,
    selected,
    belonging,
    detail,
    fileId,
    view,
    evidenceFiles,
    new Set(
      Object.entries(data.packageLayers).flatMap(([id, layer]) =>
        layer === null ? [id] : []
      )
    )
  );
  const fileLabelBudget = Math.max(
    3,
    Math.floor((view.width * view.height * pixels * pixels) / 40_000)
  );
  let fileLabels = 0;
  let regionLabels = 0;
  const regionLabelBudget = Math.max(
    2,
    Math.min(
      6,
      Math.floor((view.width * view.height * pixels * pixels) / 90_000)
    )
  );
  const focusedName = candidates.find(
    (label) => label.file?.id === fileId
  )?.text;
  const distinct = candidates.filter(
    (label) => label.file || label.text !== focusedName
  );
  const labels = visibleLabels(distinct.map(project), view).filter((label) => {
    if (label.regionId ?? label.compositeId) {
      regionLabels += 1;
      if (regionLabels > regionLabelBudget) {
        return false;
      }
    }
    if (!label.file || label.file.id === fileId) {
      return true;
    }
    fileLabels += 1;
    return fileLabels <= fileLabelBudget;
  });
  ctx.textAlign = "center";
  for (const label of labels) {
    ctx.globalAlpha = label.opacity ?? 1;
    ctx.font = label.font;
    ctx.strokeStyle = inks.labelHalo;
    ctx.lineWidth = (label.file?.id === fileId ? 6 : 3) / pixels;
    ctx.strokeText(label.text, label.x, label.y);
    ctx.fillStyle = labelInk(label, fileId);
    ctx.fillText(label.text, label.x, label.y);
    if (label.caption) {
      paintCaption(ctx, label, label.caption, pixels);
    }
  }
  ctx.globalAlpha = 1;
  return labels;
}

function labelInk(label: MapLabel, fileId: string | null): string {
  if (label.file?.id === fileId) {
    return inks.selection;
  }
  return label.folder ? inks.folder : inks.label;
}

/** A folder name's size in screen pixels, under a district's. */
const folderNameSize = 13;

/**
 * Each island's first branching folder's subfolders, named below it with a
 * trailing slash ("web/" in `src`) at the centroid of their cells, from island zoom: after the districts' names, so a district
 * wins a collision, and before the island's and the files'. None on an
 * island "Group files by responsibility" has rearranged.
 */
function addFolderLabels(
  data: AtlasData,
  territories: Territory[],
  belonging: BelongingLayer | null | undefined,
  add: (
    territory: Territory,
    text: string,
    x: number,
    y: number,
    size: number,
    face: string,
    extra?: Partial<MapLabel>
  ) => void,
  pixels: number
) {
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
      const count = Math.max(1, cell.sites.length);
      const x = cell.sites.reduce((sum, site) => sum + site.x, 0) / count;
      const y = cell.sites.reduce((sum, site) => sum + site.y, 0) / count;
      // Set a line above the centroid, where a proximity tie ends in a bead.
      add(
        territory,
        `${name}/`,
        territory.x + x,
        territory.y + y - size,
        size,
        "AtlasBody",
        { folder: true, font: `italic ${size}px AtlasBody` }
      );
    }
  }
}

function paintCaption(
  ctx: CanvasRenderingContext2D,
  label: MapLabel,
  caption: string,
  pixels: number
) {
  ctx.save();
  ctx.font = `${9.5 / pixels}px AtlasBody`;
  ctx.letterSpacing = `${1.4 / pixels}px`;
  const y = label.y + 14 / pixels;
  ctx.lineWidth = 2.5 / pixels;
  ctx.strokeText(caption, label.x, y);
  ctx.fillStyle = inks.labelCaption;
  ctx.fillText(caption, label.x, y);
  ctx.restore();
}

function addTerritoryLabels(
  territories: Territory[],
  pixels: number,
  add: (
    territory: Territory,
    text: string,
    x: number,
    y: number,
    size: number,
    face: string,
    extra?: Partial<MapLabel>
  ) => void,
  selected: string | null,
  belonging: BelongingLayer | null | undefined,
  detail: {
    composition: number;
    districts: number;
    files: number;
    specks: number;
  },
  fileId: string | null,
  view: InkView,
  evidenceFiles: Set<string> | undefined,
  unplaced: ReadonlySet<string>
) {
  for (const p of territories) {
    const size = Math.min(
      26 / pixels,
      Math.max(12 / pixels, territoryLabelSize(p.radius))
    );
    if (size * pixels >= 9) {
      const count = p.files.length;
      add(p, p.label, p.x, p.y + territoryLabelY(p), size, "AtlasDisplay", {
        // A package the graph could not place sits at the foundation, off the
        // latitude scale; its caption says so.
        caption: `${count.toLocaleString("en")} ${count === 1 ? "FILE" : "FILES"}${unplaced.has(p.id) ? " · NO LAYER" : ""}`,
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
    addFileLabels(p, fileId, belonging, evidenceFiles, add, pixels, detail);
  }
}

function addFileLabels(
  p: Territory,
  fileId: string | null,
  belonging: BelongingLayer | null | undefined,
  evidenceFiles: Set<string> | undefined,
  add: (
    territory: Territory,
    text: string,
    x: number,
    y: number,
    size: number,
    face: string,
    extra?: Partial<MapLabel>
  ) => void,
  pixels: number,
  detail: {
    composition: number;
    districts: number;
    files: number;
    specks: number;
  }
) {
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
    add(
      p,
      f.path.split("/").at(-1) ?? f.path,
      p.x + f.x,
      p.y + f.y - 7 / pixels,
      (belonging?.files ? 17 : 15) / pixels,
      "AtlasBody",
      { file: f, opacity: detail.files }
    );
  }
}

function addRegionLabels(
  belonging: BelongingLayer | null | undefined,
  detail: {
    composition: number;
    districts: number;
    files: number;
    specks: number;
  },
  add: (
    territory: Territory,
    text: string,
    x: number,
    y: number,
    size: number,
    face: string,
    extra?: Partial<MapLabel>
  ) => void,
  composition:
    | {
        fileId: string;
        marks: CompositionMark[];
        active: string[];
        names: Record<string, string>;
        stationary?: string[];
      }
    | undefined,
  pixels: number,
  namesItsFolder: FolderNamed
) {
  if (belonging) {
    addBelongingRegionLabels(
      belonging,
      detail,
      add,
      composition,
      pixels,
      namesItsFolder
    );
  }
}

function addBelongingRegionLabels(
  belonging: BelongingLayer,
  detail: {
    composition: number;
    districts: number;
    files: number;
    specks: number;
  },
  add: (
    territory: Territory,
    text: string,
    x: number,
    y: number,
    size: number,
    face: string,
    extra?: Partial<MapLabel>
  ) => void,
  composition:
    | {
        fileId: string;
        marks: CompositionMark[];
        active: string[];
        names: Record<string, string>;
        stationary?: string[];
      }
    | undefined,
  pixels: number,
  namesItsFolder: FolderNamed
) {
  const visitRegion = (region: BelongingRegion) => {
    if (!region.label) {
      return;
    }
    if (region.collection) {
      return;
    }
    const parent = belonging.parents?.includes(region);
    const regionStrength = Math.max(detail.districts, parent ? 0.2 : 0);
    if (regionStrength < 0.05) {
      return;
    }
    if (!parent && detail.composition >= 0.5) {
      return;
    }
    const center = region.members.reduce(
      (sum, file) => ({
        x: sum.x + file.x / region.members.length,
        y: sum.y + file.y / region.members.length,
      }),
      { x: 0, y: 0 }
    );
    const anchor =
      region.anchor ??
      [...region.members].sort(
        (a, b) =>
          Math.hypot(a.x - center.x, a.y - center.y) -
          Math.hypot(b.x - center.x, b.y - center.y)
      )[0];
    const text = region.label.replace(paintLabelsPattern, "");
    if (!anchor || namesItsFolder(belonging.territory, anchor, text)) {
      return;
    }
    add(
      belonging.territory,
      text,
      belonging.territory.x + anchor.x,
      belonging.territory.y +
        anchor.y -
        regionLabelLift(parent, region, composition, belonging) / pixels,
      15 / pixels,
      "Georgia",
      {
        ...(region.children
          ? { compositeId: region.id }
          : { regionId: region.id }),
        opacity: (parent ? 1 : (belonging.reveal ?? 1)) * regionStrength,
      }
    );
  };
  for (const region of [
    ...(belonging.parents ?? []),
    ...belonging.regions,
  ].sort(
    (a, b) =>
      Number(belonging.parents?.includes(b)) -
        Number(belonging.parents?.includes(a)) ||
      Number(belonging.regions.includes(b)) -
        Number(belonging.regions.includes(a)) ||
      b.members.length - a.members.length
  )) {
    visitRegion(region);
  }
}

function regionLabelLift(
  parent: boolean | undefined,
  region: BelongingRegion,
  composition:
    | {
        fileId: string;
        marks: CompositionMark[];
        active: string[];
        names: Record<string, string>;
        stationary?: string[];
      }
    | undefined,
  belonging: BelongingLayer
) {
  return parent && !region.children && (composition || belonging.files)
    ? 36
    : 8;
}
