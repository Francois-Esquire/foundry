import type { BelongingLayer, BelongingRegion } from "../belonging";
import { filePen, labelPriority, territoryLabelSize } from "../codex/bindings";
import type { CompositionMark } from "../composition-layout";
import { compositionInsideLand } from "../composition-placement";
import type { Continent } from "../continent";
import { continentCoasts } from "../continent";
import { territoryLabelY } from "../geography";
import type { ResponsibilityOverlay } from "../responsibility-focus";
import type { AtlasData, AtlasFile, Polygon, Territory } from "../types";
import { detailLevel, fileInView } from "./detail-level";
import type { InkView, MapLabel } from "./exploration";
import { visibleLabels } from "./exploration";
import { paintOcean } from "./ocean";
import { paintNaturalFeatures } from "./paint-features";
import { paintChartGrid, paintCoastInk } from "./paint-paper";
import { paintResponsibility } from "./paint-responsibility";
import { paintReliefInk, type ReliefInk } from "./relief-ink";
import { settlementColor } from "./terrain";
import type { ContourLine } from "./topography";
import { paintTopography } from "./topography";

const paintLabelsPattern = /^src\//;

function trace(ctx: CanvasRenderingContext2D, polygons: Polygon[]): void {
  ctx.beginPath();
  for (const polygon of polygons) {
    for (const ring of polygon) {
      ring.forEach(([x, y], i) => {
        if (i) {
          ctx.lineTo(x, y);
        } else {
          ctx.moveTo(x, y);
        }
      });
      ctx.closePath();
    }
  }
}

export function paintMap(
  canvas: HTMLCanvasElement,
  data: AtlasData,
  selected: string | null,
  fileId: string | null,
  layer: "sea" | "coast" | "ink" = "sea",
  view?: InkView,
  initialNeighborhoodId?: string,
  topography: ContourLine[] = [],
  initialResponsibility: ResponsibilityOverlay | null = null,
  showConnections = false,
  initialBelonging: BelongingLayer | null = null,
  matches?: BelongingRegion,
  continents: Continent[] = [],
  streams = false,
  relief: ReliefInk[] = []
): MapLabel[] {
  let belonging = initialBelonging;
  let responsibility = initialResponsibility;
  let neighborhoodId = initialNeighborhoodId;
  const ctx = canvas.getContext("2d");
  collectScale(ctx, canvas, view, data);
  if (layer === "sea") {
    paintOcean(ctx, data, continentCoasts(data, continents));
    return [];
  }
  if (layer === "coast") {
    const joined = new Set(
      continents.flatMap((c) => c.members.map((p) => p.id))
    );
    for (const c of continents) {
      trace(
        ctx,
        c.field.outline.map((ring) => [ring])
      );
      ctx.fillStyle = "#c4cca0";
      ctx.fill();
    }
    for (const p of data.territories) {
      paintLand(ctx, p, joined.has(p.id));
    }
    return [];
  }
  if (view) {
    paintChartGrid(ctx, view, data);
  }
  paintPaper(ctx, data, view, selected);
  paintReliefInk(ctx, relief, view?.pixelsPerUnit ?? 1);
  const regions = new Map(data.territories.map((p) => [p.id, p]));
  const pixels = view?.pixelsPerUnit ?? 1;
  const focusedFileVisible =
    !(fileId && view) || fileInView(regions.get(selected ?? ""), fileId, view);
  ({ neighborhoodId, belonging } = paintMapEntries4(
    focusedFileVisible,
    neighborhoodId,
    belonging
  ));
  responsibility = paintMapEntries7(view, responsibility, regions);
  const detail = detailLevel(
    pixels,
    (responsibility?.composition?.marks.length ?? 0) > 0
  );
  const regionStrength = Math.max(
    detail.districts,
    belonging?.parents?.length ? 0.2 : 0
  );
  const matchTerritory = regions.get(responsibility?.territoryId ?? "");
  const baselineRegionId = belonging?.pinned;
  belonging = paintMapEntries6(
    matches,
    matchTerritory,
    focusedFileVisible,
    belonging
  );
  const activeRegion = belonging?.regions.find(
    (region) => region.id === (belonging.hovered ?? belonging.pinned)
  );
  paintMapEntries(
    belonging,
    regionStrength,
    ctx,
    responsibility,
    baselineRegionId,
    pixels,
    matches,
    activeRegion,
    detail,
    streams
  );

  const evidenceFiles: Set<string> | undefined = paintMapEntries5(
    responsibility,
    focusedFileVisible,
    undefined
  );
  ctx.setLineDash([]);
  paintMapEntries2(showConnections, fileId, responsibility, data, ctx, pixels);
  paintMapP(
    data,
    ctx,
    neighborhoodId,
    detail,
    selected,
    evidenceFiles,
    pixels,
    belonging,
    activeRegion
  );
  const responsibilityTerritory =
    responsibility && regions.get(responsibility.territoryId);
  paintMapEntries8(
    responsibility,
    responsibilityTerritory,
    selected,
    ctx,
    pixels
  );
  paintFileFocus(ctx, data, selected, fileId, pixels);
  const labels = paintLabels(
    ctx,
    data,
    selected,
    fileId,
    view ?? {
      height: data.height,
      pixelsPerUnit: 1,
      width: data.width,
      x: 0,
      y: 0,
    },
    neighborhoodId,
    detail,
    evidenceFiles ??
      (activeRegion
        ? new Set(activeRegion.members.map((file) => file.id))
        : undefined),
    responsibility?.composition,
    belonging
  );
  if (view) {
    ctx.save();
    ctx.globalAlpha = 1 - detail.composition * 0.8;
    paintTopography(ctx, topography, view, labels);
    ctx.restore();
  }
  paintCompass(ctx, data.width / 2 - 88, -data.height / 2 + 94);
  ctx.fillStyle = "#64786b";
  ctx.textAlign = "center";
  ctx.font = "italic 14px Georgia";
  ctx.fillText("The dependency sea", 0, data.height / 2 - 38);
  ctx.font = "6px AtlasBody";
  ctx.fillText(
    "DISTANCE EXPRESSES RELATIONSHIP · NOT PHYSICAL SCALE",
    0,
    data.height / 2 - 22
  );
  return labels;
}

function collectScale(
  ctx: CanvasRenderingContext2D | null,
  canvas: HTMLCanvasElement,
  view: InkView | undefined,
  data: AtlasData
): asserts ctx is CanvasRenderingContext2D {
  if (!ctx) {
    throw new Error("Canvas rendering is unavailable.");
  }
  const scale = canvas.width / (view?.width ?? data.width);
  ctx.resetTransform();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, canvas.height / (view?.height ?? data.height));
  ctx.translate(
    (view?.width ?? data.width) / 2 - (view?.x ?? 0),
    (view?.height ?? data.height) / 2 - (view?.y ?? 0)
  );
}

function paintMapEntries8(
  responsibility: ResponsibilityOverlay | null,
  responsibilityTerritory: Territory | null | undefined,
  selected: string | null,
  ctx: CanvasRenderingContext2D,
  pixels: number
) {
  if (
    responsibility &&
    responsibilityTerritory &&
    selected === responsibility.territoryId
  ) {
    paintResponsibility(ctx, responsibilityTerritory, responsibility, pixels);
  }
}

function paintMapEntries7(
  view: InkView | undefined,
  initialResponsibility: ResponsibilityOverlay | null,
  regions: Map<string, Territory>
): ResponsibilityOverlay | null {
  let responsibility = initialResponsibility;
  if (
    view &&
    responsibility?.composition &&
    !fileInView(
      regions.get(responsibility.territoryId),
      responsibility.composition.fileId,
      view
    )
  ) {
    responsibility = {
      ...responsibility,
      composition: undefined,
      trace: undefined,
    };
  }
  return responsibility;
}

function paintMapEntries6(
  matches: BelongingRegion | undefined,
  matchTerritory: Territory | undefined,
  focusedFileVisible: boolean,
  initialBelonging: BelongingLayer | null
): BelongingLayer | null {
  let belonging = initialBelonging;
  if (matches && matchTerritory && focusedFileVisible) {
    belonging = {
      ...belonging,
      pinned: matches.id,
      regions: [...(belonging?.regions ?? []), matches],
      territory: matchTerritory,
    };
  }
  return belonging;
}

function paintMapEntries5(
  responsibility: ResponsibilityOverlay | null,
  focusedFileVisible: boolean,
  initialEvidenceFiles: Set<string> | undefined
): Set<string> | undefined {
  let evidenceFiles = initialEvidenceFiles;
  if (responsibility && focusedFileVisible) {
    evidenceFiles = new Set([
      ...responsibility.members,
      ...responsibility.related,
      ...responsibility.unresolved,
      ...resolvePaintMapEntries5(responsibility),
    ]);
  } else {
    evidenceFiles = undefined;
  }
  return evidenceFiles;
}

function resolvePaintMapEntries5(
  responsibility: ResponsibilityOverlay
): string[] {
  if (responsibility.routes) {
    return [
      ...responsibility.routes.baseline,
      ...responsibility.routes.proposed,
    ].flatMap((route) =>
      [route.source, route.target].flatMap((endpoint) =>
        endpoint.kind === "file" ? [endpoint.id] : []
      )
    );
  }
  return [];
}

function paintMapEntries4(
  focusedFileVisible: boolean,
  initialNeighborhoodId: string | undefined,
  initialBelonging: BelongingLayer | null
): { neighborhoodId: string | undefined; belonging: BelongingLayer | null } {
  let belonging = initialBelonging;
  let neighborhoodId = initialNeighborhoodId;
  if (!focusedFileVisible) {
    neighborhoodId = undefined;
    if (belonging) {
      belonging = { ...belonging, pinned: undefined };
    }
  }
  return { belonging, neighborhoodId };
}

function paintPaper(
  ctx: CanvasRenderingContext2D,
  data: AtlasData,
  view: InkView | undefined,
  selected: string | null
) {
  for (const territory of data.territories) {
    paintCoastInk(
      ctx,
      territory,
      view?.pixelsPerUnit ?? 1,
      territory.id === selected
    );
  }
}

function paintMapEntries2(
  showConnections: boolean,
  fileId: string | null,
  responsibility: ResponsibilityOverlay | null,
  data: AtlasData,
  ctx: CanvasRenderingContext2D,
  pixels: number
) {
  if (showConnections && fileId && !responsibility) {
    const locations = new Map(
      data.territories.flatMap((p) =>
        p.files.map((f) => [f.id, { x: p.x + f.x, y: p.y + f.y }] as const)
      )
    );
    ctx.strokeStyle = "#8a5a31ba";
    ctx.lineWidth = 1 / pixels;
    ctx.setLineDash([3 / pixels, 5 / pixels]);
    for (const edge of data.fileEdges) {
      if (edge.source !== fileId && edge.target !== fileId) {
        continue;
      }
      const a = locations.get(edge.source),
        b = locations.get(edge.target);
      if (!(a && b)) {
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}

function paintMapP(
  data: AtlasData,
  ctx: CanvasRenderingContext2D,
  neighborhoodId: string | undefined,
  detail: {
    composition: number;
    districts: number;
    files: number;
    specks: number;
  },
  selected: string | null,
  evidenceFiles: Set<string> | undefined,
  pixels: number,
  belonging: BelongingLayer | null,
  activeRegion: BelongingRegion | undefined
) {
  const landmarks = new Set(
    belonging?.features?.landmarks.map((landmark) => landmark.file.id) ?? []
  );
  for (const p of data.territories) {
    ctx.save();
    ctx.translate(p.x, p.y);
    const members = p.neighborhoods.find(
      (n) => n.id === neighborhoodId
    )?.members;
    paintMapPF(
      p,
      detail,
      ctx,
      selected,
      members,
      evidenceFiles,
      pixels,
      p.id === belonging?.territory.id ? landmarks : undefined
    );
    paintExactMembers(ctx, p, belonging, activeRegion, detail, pixels);
    ctx.restore();
  }
}

/** Exact members of the selected group, drawn as solid marks over the files. */
function paintExactMembers(
  ctx: CanvasRenderingContext2D,
  p: Territory,
  belonging: BelongingLayer | null,
  activeRegion: BelongingRegion | undefined,
  detail: { composition: number },
  pixels: number
) {
  const exactMembers =
    belonging?.files ??
    (activeRegion && !activeRegion.children ? activeRegion.members : undefined);
  if (
    !exactMembers ||
    p.id !== belonging?.territory.id ||
    detail.composition >= 0.5
  ) {
    return;
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = belonging.files
    ? "#4a4233"
    : (activeRegion?.color ?? "#4a4233");
  ctx.strokeStyle = "#f1ead9";
  ctx.lineWidth = 1 / pixels;
  for (const file of exactMembers) {
    const size = (belonging.files ? 5 : 3.5) / pixels;
    ctx.fillRect(file.x - size / 2, file.y - size / 2, size, size);
    ctx.strokeRect(file.x - size / 2, file.y - size / 2, size, size);
  }
}

function paintMapPF(
  p: Territory,
  detail: {
    composition: number;
    districts: number;
    files: number;
    specks: number;
  },
  ctx: CanvasRenderingContext2D,
  selected: string | null,
  members: string[] | undefined,
  evidenceFiles: Set<string> | undefined,
  pixels: number,
  landmarks?: Set<string>
) {
  for (const f of p.files) {
    // A landmark stands in for its file's speck and mark; selection still rings it.
    const landmark = landmarks?.has(f.id) ?? false;
    if (detail.specks > 0 && !landmark) {
      ctx.globalAlpha = detail.specks;
      ctx.fillStyle = settlementColor(f.kind);
      ctx.fillRect(f.x - 0.9, f.y - 1.35, 1.8, 2.7);
    }
    if (detail.files < 0.05) {
      continue;
    }
    ctx.globalAlpha =
      detail.files *
      ((p.id === selected && members && !members.includes(f.id)) ||
      (evidenceFiles?.size && !evidenceFiles.has(f.id))
        ? 0.15
        : 1);
    ctx.fillStyle = settlementColor(f.kind);
    ctx.strokeStyle = ctx.fillStyle;
    const size = filePen(pixels);
    ctx.lineWidth = Math.min(0.45, 1 / pixels);
    if (!landmark) {
      paintMapPFEntries(f, ctx, size);
    }
  }
}

function paintFileFocus(
  ctx: CanvasRenderingContext2D,
  data: AtlasData,
  selected: string | null,
  fileId: string | null,
  pixels: number
) {
  const territory = data.territories.find((item) => item.id === selected);
  const file = territory?.files.find((item) => item.id === fileId);
  if (!(territory && file)) {
    return;
  }
  ctx.save();
  ctx.translate(territory.x + file.x, territory.y + file.y);
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(0, 0, 9 / pixels, 0, Math.PI * 2);
  ctx.strokeStyle = "#faf4e4";
  ctx.lineWidth = 5 / pixels;
  ctx.stroke();
  ctx.strokeStyle = "#875222";
  ctx.lineWidth = 2 / pixels;
  ctx.stroke();
  ctx.fillStyle = "#875222";
  ctx.fillRect(-2 / pixels, -2 / pixels, 4 / pixels, 4 / pixels);
  ctx.restore();
}

function paintMapPFEntries(
  f: AtlasFile,
  ctx: CanvasRenderingContext2D,
  size: number
) {
  if (f.architectureKind === "commons") {
    ctx.beginPath();
    ctx.arc(f.x, f.y, size, 0, Math.PI * 2);
    ctx.stroke();
  } else if (f.architectureKind === "junction") {
    ctx.beginPath();
    ctx.moveTo(f.x - size, f.y);
    ctx.lineTo(f.x + size, f.y);
    ctx.moveTo(f.x, f.y - size);
    ctx.lineTo(f.x, f.y + size);
    ctx.stroke();
    ctx.strokeRect(f.x - size / 2, f.y - size / 2, size, size);
  } else if (f.architectureKind === "mixed") {
    ctx.fillRect(f.x - size, f.y - size / 2, size * 0.65, size);
    ctx.strokeRect(f.x + size * 0.35, f.y - size / 2, size * 0.65, size);
  } else if (f.architectureKind === "unknown") {
    ctx.strokeRect(f.x - size / 2, f.y - size / 2, size, size);
  } else if (f.kind === "story") {
    ctx.beginPath();
    ctx.arc(f.x, f.y, size, 0, Math.PI);
    ctx.closePath();
    ctx.fill();
  } else if (f.kind === "test") {
    ctx.strokeRect(f.x - size / 2, f.y - size / 2, size, size * 1.5);
    ctx.fillRect(f.x - size / 4, f.y, size / 2, size / 2);
  } else {
    ctx.fillRect(f.x - size / 2, f.y - size / 2, size, size * 1.5);
  }
}

/** Landmarks and marsh stay through file zoom; they recede only under composition. */
function featureStrength(
  belonging: BelongingLayer,
  detail: { composition: number; districts: number; files: number }
) {
  return (
    Math.min(1, detail.districts + detail.files) *
    (1 - detail.composition * 0.8) *
    (belonging.reveal ?? 1)
  );
}

function paintMapEntries(
  belonging: BelongingLayer | null,
  regionStrength: number,
  ctx: CanvasRenderingContext2D,
  responsibility: ResponsibilityOverlay | null,
  baselineRegionId: string | undefined,
  pixels: number,
  matches: BelongingRegion | undefined,
  activeRegion: BelongingRegion | undefined,
  detail: {
    composition: number;
    districts: number;
    files: number;
    specks: number;
  },
  streams: boolean
) {
  if (!belonging) {
    return;
  }
  const features = belonging.features ? featureStrength(belonging, detail) : 0;
  if (regionStrength <= 0 && features <= 0) {
    return;
  }
  ctx.save();
  ctx.translate(belonging.territory.x, belonging.territory.y);
  trace(ctx, belonging.territory.coast);
  ctx.clip("evenodd");
  const enclosing = belonging.parents?.find(
    (region) => region.children && !region.collection
  );
  if (regionStrength > 0) {
    paintMapEntriesParent(
      belonging,
      ctx,
      enclosing,
      responsibility,
      baselineRegionId,
      regionStrength,
      pixels
    );
    paintMapEntriesRegion(
      belonging,
      ctx,
      enclosing,
      matches,
      activeRegion,
      responsibility,
      baselineRegionId,
      detail,
      regionStrength,
      pixels
    );
  }
  if (belonging.features && features > 0) {
    paintNaturalFeatures(ctx, belonging.features, {
      focus: belonging.featureFocus,
      pixels,
      streams,
      strength: features,
    });
  }
  if (enclosing && regionStrength > 0) {
    ctx.fillStyle = enclosing.color;
    ctx.globalAlpha = 0.65 * regionStrength;
    const members =
      belonging.files ?? belonging.regions.flatMap((region) => region.members);
    for (const file of members) {
      if (compositionInsideLand(file.x, file.y, enclosing.polygons)) {
        continue;
      }
      ctx.fillRect(
        file.x - 1.5 / pixels,
        file.y - 1.5 / pixels,
        3 / pixels,
        3 / pixels
      );
    }
  }
  ctx.restore();
}

function paintMapEntriesRegion(
  belonging: BelongingLayer,
  ctx: CanvasRenderingContext2D,
  enclosing: BelongingRegion | undefined,
  matches: BelongingRegion | undefined,
  activeRegion: BelongingRegion | undefined,
  responsibility: ResponsibilityOverlay | null,
  baselineRegionId: string | undefined,
  detail: {
    composition: number;
    districts: number;
    files: number;
    specks: number;
  },
  regionStrength: number,
  pixels: number
) {
  for (const region of belonging.regions) {
    ctx.save();
    if (enclosing && region !== matches) {
      trace(ctx, enclosing.polygons);
      ctx.clip("evenodd");
    }
    const active = region === activeRegion;
    const retained = responsibility?.trace && region.id === baselineRegionId;
    trace(ctx, region.polygons);
    ctx.strokeStyle = region.color;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.globalAlpha =
      resolvePaintMapEntries2(retained, active, belonging, region) *
      (retained ? 1 : (1 - detail.composition) * (belonging.reveal ?? 1)) *
      regionStrength;
    ctx.fill("evenodd");
    ctx.globalAlpha =
      resolvePaintMapEntries3(retained, active, belonging, region, pixels) *
      (retained ? 1 : (1 - detail.composition) * (belonging.reveal ?? 1)) *
      regionStrength;
    ctx.lineWidth = (active ? 1.5 : 0.7) / pixels;
    ctx.setLineDash(region.uncertain ? [3 / pixels, 3 / pixels] : []);
    ctx.stroke();
    ctx.restore();
  }
}

function paintMapEntriesParent(
  belonging: BelongingLayer,
  ctx: CanvasRenderingContext2D,
  enclosing: BelongingRegion | undefined,
  responsibility: ResponsibilityOverlay | null,
  baselineRegionId: string | undefined,
  regionStrength: number,
  pixels: number
) {
  for (const parent of [
    ...(belonging.surroundings ?? []),
    ...(belonging.parents ?? []),
  ]) {
    if (parent.collection) {
      continue;
    }
    const passive = belonging.surroundings?.includes(parent);
    ctx.save();
    if (!parent.children && enclosing) {
      trace(ctx, enclosing.polygons);
      ctx.clip("evenodd");
    }
    trace(ctx, parent.polygons);
    ctx.strokeStyle = parent.color;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.globalAlpha =
      resolvePaintMapEntries(
        responsibility,
        parent,
        baselineRegionId,
        passive
      ) * regionStrength;
    ctx.fill("evenodd");
    ctx.globalAlpha = (passive ? 0.2 : 0.45) * regionStrength;
    ctx.lineWidth = 1 / pixels;
    ctx.setLineDash(parent.children ? [] : [3 / pixels, 3 / pixels]);
    ctx.stroke();
    if (parent.anchor) {
      ctx.globalAlpha = (passive ? 0.35 : 0.85) * regionStrength;
      ctx.setLineDash([]);
      const size = 4 / pixels;
      ctx.strokeRect(
        parent.anchor.x - size,
        parent.anchor.y - size,
        size * 2,
        size * 2
      );
    }
    ctx.restore();
  }
}

function resolvePaintMapEntries3(
  retained: boolean | undefined,
  active: boolean,
  belonging: BelongingLayer,
  region: BelongingRegion,
  pixels: number
): number {
  if (retained) {
    return 0.2;
  }
  if (active) {
    return 0.3 + 0.55 * (belonging.emphasis ?? 1);
  }
  if (region.uncertain) {
    return Math.min(0.3, pixels / 30);
  }
  return 0.3;
}

function resolvePaintMapEntries2(
  retained: boolean | undefined,
  active: boolean,
  belonging: BelongingLayer,
  region: BelongingRegion
): number {
  if (retained) {
    return 0.12;
  }
  if (active) {
    return 0.14 + 0.16 * (belonging.emphasis ?? 1);
  }
  if (region.uncertain) {
    return 0.045;
  }
  return 0.14;
}

function resolvePaintMapEntries(
  responsibility: ResponsibilityOverlay | null,
  parent: BelongingRegion,
  baselineRegionId: string | undefined,
  passive: boolean | undefined
): 0.12 | 0.025 | 0.075 {
  if (responsibility?.trace && parent.id === baselineRegionId) {
    return 0.12;
  }
  if (passive) {
    return 0.025;
  }
  return 0.075;
}

function paintLand(
  ctx: CanvasRenderingContext2D,
  p: Territory,
  joined = false
): void {
  ctx.save();
  ctx.translate(p.x, p.y);
  if (!joined) {
    trace(ctx, p.shallows);
    ctx.fillStyle = "#c3cebd";
    ctx.fill("evenodd");
  }
  trace(ctx, p.coast);
  ctx.fillStyle = p.color;
  ctx.fill("evenodd");
  // Pigment is a wash into warm stock; relief supplies the landform.
  ctx.fillStyle = "#f1ead9";
  ctx.globalAlpha = 0.34;
  ctx.fill("evenodd");
  ctx.globalAlpha = 1;
  ctx.restore();
}

function paintLabels(
  ctx: CanvasRenderingContext2D,
  data: AtlasData,
  selected: string | null,
  fileId: string | null,
  view: InkView,
  neighborhoodId?: string | undefined,
  detail: {
    composition: number;
    districts: number;
    files: number;
    specks: number;
  } = detailLevel(view.pixelsPerUnit),
  evidenceFiles?: Set<string>,
  composition?: ResponsibilityOverlay["composition"],
  belonging?: BelongingLayer | null
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
  paintLabelsEntries(belonging, detail, add, composition, pixels);
  paintLabelsP(
    territories,
    pixels,
    add,
    selected,
    belonging,
    neighborhoodId,
    detail,
    fileId,
    view,
    evidenceFiles
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
  const labels = visibleLabels(distinct, view).filter((label) => {
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
    ctx.strokeStyle = "#f5efdf";
    ctx.lineWidth = (label.file?.id === fileId ? 6 : 3) / pixels;
    ctx.strokeText(label.text, label.x, label.y);
    ctx.fillStyle = label.file?.id === fileId ? "#743d1b" : "#39372e";
    ctx.fillText(label.text, label.x, label.y);
  }
  ctx.globalAlpha = 1;
  return labels;
}

function paintLabelsP(
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
  neighborhoodId: string | undefined,
  detail: {
    composition: number;
    districts: number;
    files: number;
    specks: number;
  },
  fileId: string | null,
  view: InkView,
  evidenceFiles: Set<string> | undefined
) {
  for (const p of territories) {
    const size = Math.min(
      26 / pixels,
      Math.max(12 / pixels, territoryLabelSize(p.radius))
    );
    if (size * pixels >= 9) {
      add(p, p.label, p.x, p.y + territoryLabelY(p), size, "AtlasDisplay");
    }
    if (p.id !== selected && p.id !== belonging?.territory.id) {
      continue;
    }
    paintLabelsPN(p, neighborhoodId, belonging, detail, add, pixels);
    if (
      pixels < 5 ||
      detail.files < 0.5 ||
      fileInView(p, fileId ?? undefined, view)
    ) {
      continue;
    }
    paintLabelsPF(
      p,
      fileId,
      belonging,
      evidenceFiles,
      neighborhoodId,
      add,
      pixels,
      detail
    );
  }
}

function paintLabelsPN(
  p: Territory,
  neighborhoodId: string | undefined,
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
  pixels: number
) {
  for (const n of [...p.neighborhoods].sort(
    (a, b) =>
      Number(b.id === neighborhoodId) - Number(a.id === neighborhoodId) ||
      b.members.length - a.members.length
  )) {
    if (belonging?.territory.id === p.id) {
      break;
    }
    if (detail.districts < 0.1) {
      break;
    }
    if (neighborhoodId && n.id !== neighborhoodId) {
      continue;
    }
    const files = p.files.filter((f) => n.members.includes(f.id));
    if (!files.length) {
      continue;
    }
    add(
      p,
      n.label,
      p.x + files.reduce((sum, f) => sum + f.x, 0) / files.length,
      p.y + Math.min(...files.map((f) => f.y)) - 10 / pixels,
      14 / pixels,
      "Georgia",
      { neighborhoodId: n.id, opacity: detail.districts }
    );
  }
}

function paintLabelsPF(
  p: Territory,
  fileId: string | null,
  belonging: BelongingLayer | null | undefined,
  evidenceFiles: Set<string> | undefined,
  neighborhoodId: string | undefined,
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
    if (
      neighborhoodId &&
      !p.neighborhoods
        .find((n) => n.id === neighborhoodId)
        ?.members.includes(f.id)
    ) {
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

function paintLabelsEntries(
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
  pixels: number
) {
  if (belonging) {
    paintLabelsEntriesRegion(belonging, detail, add, composition, pixels);
  }
}

function paintLabelsEntriesRegion(
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
  pixels: number
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
    if (!anchor) {
      return;
    }
    add(
      belonging.territory,
      region.label.replace(paintLabelsPattern, ""),
      belonging.territory.x + anchor.x,
      belonging.territory.y +
        anchor.y -
        paintLabelsEntriesRegionEntries(
          parent,
          region,
          composition,
          belonging
        ) /
          pixels,
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

function paintLabelsEntriesRegionEntries(
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

function paintCompass(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = "#8b7656";
  ctx.fillStyle = "#8b7656";
  ctx.lineWidth = 0.65;
  ctx.beginPath();
  ctx.arc(0, 0, 23, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 8; i += 1) {
    ctx.save();
    ctx.rotate((i * Math.PI) / 4);
    ctx.beginPath();
    ctx.moveTo(0, -35);
    ctx.lineTo(4, 0);
    ctx.lineTo(0, 8);
    ctx.lineTo(-4, 0);
    ctx.closePath();
    if (i % 2 === 0) {
      ctx.fill();
    } else {
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.font = "10px AtlasDisplay";
  ctx.textAlign = "center";
  ctx.fillText("N", 0, -43);
  ctx.restore();
}
