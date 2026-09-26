import type { BelongingLayer, BelongingRegion } from "./belonging";
import { compositionInsideLand } from "./composition-placement";
import type { Continent } from "./continent";
import { continentCoasts } from "./continent";
import { detailLevel, fileInView } from "./detail-level";
import type { InkView, MapLabel } from "./exploration";
import { visibleLabels } from "./exploration";
import { territoryLabelY } from "./geography";
import { paintOcean } from "./ocean";
import { paintResponsibility } from "./paint-responsibility";
import type { ResponsibilityOverlay } from "./responsibility-focus";
import { settlementColor } from "./terrain";
import type { ContourLine } from "./topography";
import { paintTopography } from "./topography";
import type { AtlasData, Polygon, Territory } from "./types";

export function trace(
  ctx: CanvasRenderingContext2D,
  polygons: Polygon[]
): void {
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
  neighborhoodId?: string,
  topography: ContourLine[] = [],
  responsibility: ResponsibilityOverlay | null = null,
  showConnections = false,
  belonging: BelongingLayer | null = null,
  matches?: BelongingRegion,
  continents: Continent[] = []
): MapLabel[] {
  const ctx = canvas.getContext("2d");
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
      paintLand(ctx, p, selected, joined.has(p.id));
    }
    return [];
  }
  if (view) {
    const left = view.x - view.width / 2;
    const top = view.y - view.height / 2;
    const right = left + view.width;
    const bottom = top + view.height;
    ctx.strokeStyle = "#7f80604a";
    ctx.lineWidth = 0.4;
    for (let x = Math.ceil(left / 90) * 90; x <= right; x += 90) {
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
    }
    for (let y = Math.ceil(top / 90) * 90; y <= bottom; y += 90) {
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
    }
  }
  const regions = new Map(data.territories.map((p) => [p.id, p]));
  const pixels = view?.pixelsPerUnit ?? 1;
  const focusedFileVisible =
    !(fileId && view) || fileInView(regions.get(selected ?? ""), fileId, view);
  if (!focusedFileVisible) {
    neighborhoodId = undefined;
    if (belonging) {
      belonging = { ...belonging, pinned: undefined };
    }
  }
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
  if (matches && matchTerritory && focusedFileVisible) {
    belonging = {
      ...belonging,
      pinned: matches.id,
      regions: [...(belonging?.regions ?? []), matches],
      territory: matchTerritory,
    };
  }
  const activeRegion = belonging?.regions.find(
    (region) => region.id === (belonging.hovered ?? belonging.pinned)
  );
  if (belonging && regionStrength > 0) {
    ctx.save();
    ctx.translate(belonging.territory.x, belonging.territory.y);
    trace(ctx, belonging.territory.coast);
    ctx.clip("evenodd");
    const enclosing = belonging.parents?.find(
      (region) => region.children && !region.collection
    );
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
      ctx.fillStyle = ctx.strokeStyle = parent.color;
      ctx.globalAlpha =
        (responsibility?.trace && parent.id === baselineRegionId
          ? 0.12
          : passive
            ? 0.025
            : 0.075) * regionStrength;
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
    for (const region of belonging.regions) {
      ctx.save();
      if (enclosing && region !== matches) {
        trace(ctx, enclosing.polygons);
        ctx.clip("evenodd");
      }
      const active = region === activeRegion;
      const retained = responsibility?.trace && region.id === baselineRegionId;
      trace(ctx, region.polygons);
      ctx.fillStyle = ctx.strokeStyle = region.color;
      ctx.globalAlpha =
        (retained
          ? 0.12
          : active
            ? 0.14 + 0.16 * (belonging.emphasis ?? 1)
            : region.uncertain
              ? 0.045
              : 0.14) *
        (retained ? 1 : (1 - detail.composition) * (belonging.reveal ?? 1)) *
        regionStrength;
      ctx.fill("evenodd");
      ctx.globalAlpha =
        (retained
          ? 0.2
          : active
            ? 0.3 + 0.55 * (belonging.emphasis ?? 1)
            : region.uncertain
              ? Math.min(0.3, pixels / 30)
              : 0.3) *
        (retained ? 1 : (1 - detail.composition) * (belonging.reveal ?? 1)) *
        regionStrength;
      ctx.lineWidth = (active ? 1.5 : 0.7) / pixels;
      ctx.setLineDash(region.uncertain ? [3 / pixels, 3 / pixels] : []);
      ctx.stroke();
      ctx.restore();
    }
    if (enclosing) {
      ctx.fillStyle = enclosing.color;
      ctx.globalAlpha = 0.65 * regionStrength;
      const members =
        belonging.files ??
        belonging.regions.flatMap((region) => region.members);
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
  const evidenceFiles =
    responsibility && focusedFileVisible
      ? new Set([
          ...responsibility.members,
          ...responsibility.related,
          ...responsibility.unresolved,
          ...(responsibility.routes
            ? [
                ...responsibility.routes.baseline,
                ...responsibility.routes.proposed,
              ].flatMap((route) =>
                [route.source, route.target].flatMap((endpoint) =>
                  endpoint.kind === "file" ? [endpoint.id] : []
                )
              )
            : []),
        ])
      : undefined;
  ctx.setLineDash([]);
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
  for (const p of data.territories) {
    ctx.save();
    ctx.translate(p.x, p.y);
    const members = p.neighborhoods.find(
      (n) => n.id === neighborhoodId
    )?.members;
    for (const f of p.files) {
      if (detail.specks > 0) {
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
      const size = Math.min(1.3, 2.5 / pixels);
      ctx.lineWidth = Math.min(0.45, 1 / pixels);
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
      if (f.id === fileId) {
        ctx.strokeStyle = "#7c421d";
        ctx.lineWidth = 1 / pixels;
        ctx.beginPath();
        ctx.arc(f.x, f.y, 7 / pixels, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    const exactMembers =
      belonging?.files ??
      (activeRegion && !activeRegion.children
        ? activeRegion.members
        : undefined);
    if (
      exactMembers &&
      p.id === belonging?.territory.id &&
      detail.composition < 0.5
    ) {
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
    ctx.restore();
  }
  const responsibilityTerritory =
    responsibility && regions.get(responsibility.territoryId);
  if (
    responsibility &&
    responsibilityTerritory &&
    selected === responsibility.territoryId
  ) {
    paintResponsibility(ctx, responsibilityTerritory, responsibility, pixels);
  }
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

function paintLand(
  ctx: CanvasRenderingContext2D,
  p: Territory,
  selected: string | null,
  joined = false
): void {
  ctx.save();
  ctx.translate(p.x, p.y);
  if (!joined) {
    trace(ctx, p.shallows);
    ctx.fillStyle = "#c3cebd";
    ctx.fill("evenodd");
    ctx.strokeStyle = "#93a895";
    ctx.lineWidth = 0.45;
    ctx.stroke();
  }
  trace(ctx, p.coast);
  ctx.fillStyle = p.color;
  ctx.fill("evenodd");
  ctx.save();
  ctx.clip("evenodd");
  ctx.strokeStyle = "#79553624";
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.strokeStyle = "#fff3d950";
  ctx.lineWidth = 1.8;
  ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = selected === p.id ? "#8b532e" : "#8b8165";
  ctx.lineWidth = selected === p.id ? 1 : 0.7;
  ctx.stroke();
  ctx.restore();
}

function paintLabels(
  ctx: CanvasRenderingContext2D,
  data: AtlasData,
  selected: string | null,
  fileId: string | null,
  view: InkView,
  neighborhoodId?: string,
  detail = detailLevel(view.pixelsPerUnit),
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
  if (belonging) {
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
      if (!region.label) {
        continue;
      }
      if (region.collection) {
        continue;
      }
      const parent = belonging.parents?.includes(region);
      const regionStrength = Math.max(detail.districts, parent ? 0.2 : 0);
      if (regionStrength < 0.05) {
        continue;
      }
      if (!parent && detail.composition >= 0.5) {
        continue;
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
        continue;
      }
      add(
        belonging.territory,
        region.label.replace(/^src\//, ""),
        belonging.territory.x + anchor.x,
        belonging.territory.y +
          anchor.y -
          (parent && !region.children && (composition || belonging.files)
            ? 36
            : 8) /
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
    }
  }
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
        p.y +
          file.y +
          (composition?.fileId === file.id
            ? Math.min(0, ...composition.marks.map((mark) => mark.y)) *
              detail.composition
            : 0) -
          12 / pixels,
        15 / pixels,
        "AtlasBody",
        { file, opacity: Math.max(detail.files, detail.composition) }
      );
    }
  }
  for (const p of territories) {
    const size = Math.min(
      26 / pixels,
      Math.max(12 / pixels, 13, Math.min(22, p.radius * 0.15))
    );
    if (size * pixels >= 9) {
      add(p, p.label, p.x, p.y + territoryLabelY(p), size, "AtlasDisplay");
    }
    if (p.id !== selected && p.id !== belonging?.territory.id) {
      continue;
    }
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
    if (
      pixels < 5 ||
      detail.files < 0.5 ||
      fileInView(p, fileId ?? undefined, view)
    ) {
      continue;
    }
    for (const f of [...p.files].sort(
      (a, b) =>
        b.incoming + b.outgoing - a.incoming - a.outgoing ||
        a.id.localeCompare(b.id)
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
        (belonging?.files ? 16 : 12) / pixels,
        "AtlasBody",
        { file: f, opacity: detail.files }
      );
    }
  }
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
  const labels = visibleLabels(candidates, view).filter(
    (label) =>
      (!(label.regionId ?? label.compositeId) ||
        ++regionLabels <= regionLabelBudget) &&
      (!label.file ||
        label.file.id === fileId ||
        ++fileLabels <= fileLabelBudget)
  );
  ctx.textAlign = "center";
  for (const label of labels) {
    ctx.globalAlpha = label.opacity ?? 1;
    ctx.font = label.font;
    ctx.strokeStyle = label.territory.color;
    ctx.lineWidth = 3 / pixels;
    ctx.strokeText(label.text, label.x, label.y);
    ctx.fillStyle = "#443b2c";
    ctx.fillText(label.text, label.x, label.y);
  }
  ctx.globalAlpha = 1;
  return labels;
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
  for (let i = 0; i < 8; i++) {
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
