import type { BelongingLayer, BelongingRegion } from "../../belonging";
import { filePen, speckRadius } from "../../data/bindings";
import type { SpyglassData, SpyglassFile, Territory } from "../../data/types";
import { fileInk, inks } from "../../ladder/ink-ladder";
import type { InkState } from "./state";

/** Every file: specks at overview, marks by kind and role closer in, and a group's exact members. */
export function paintFiles(state: InkState): void {
  paintFileMarks(
    state.data,
    state.ctx,
    state.detail,
    state.evidenceFiles,
    state.pixels,
    state.belonging,
    state.activeRegion
  );
}

function paintFileMarks(
  data: SpyglassData,
  ctx: CanvasRenderingContext2D,
  detail: {
    composition: number;
    districts: number;
    files: number;
    specks: number;
  },
  evidenceFiles: Set<string> | undefined,
  pixels: number,
  belonging: BelongingLayer | null,
  activeRegion: BelongingRegion | undefined
) {
  for (const p of data.territories) {
    ctx.save();
    ctx.translate(p.x, p.y);
    paintIslandFiles(p, detail, ctx, evidenceFiles, pixels);
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
    ? inks.selection
    : (activeRegion?.color ?? inks.selection);
  ctx.strokeStyle = inks.paper;
  ctx.lineWidth = 1 / pixels;
  for (const file of exactMembers) {
    const size = (belonging.files ? 5 : 3.5) / pixels;
    ctx.fillRect(file.x - size / 2, file.y - size / 2, size, size);
    ctx.strokeRect(file.x - size / 2, file.y - size / 2, size, size);
  }
}

function paintIslandFiles(
  p: Territory,
  detail: {
    composition: number;
    districts: number;
    files: number;
    specks: number;
  },
  ctx: CanvasRenderingContext2D,
  evidenceFiles: Set<string> | undefined,
  pixels: number
) {
  if (detail.specks > 0) {
    paintSpecks(ctx, p.files, detail.specks, pixels);
  }
  for (const f of p.files) {
    if (detail.files < 0.05) {
      continue;
    }
    ctx.globalAlpha =
      detail.files *
      (evidenceFiles?.size && !evidenceFiles.has(f.id) ? 0.15 : 1);
    ctx.fillStyle = fileInk(f.kind);
    ctx.strokeStyle = ctx.fillStyle;
    const size = filePen(pixels);
    ctx.lineWidth = Math.min(0.45, 1 / pixels);
    paintFileMark(f, ctx, size);
  }
}

/** One round dot per file, filled once per kind so overview repaints stay cheap. */
function paintSpecks(
  ctx: CanvasRenderingContext2D,
  files: readonly SpyglassFile[],
  opacity: number,
  pixels: number
) {
  const radius = speckRadius(pixels);
  const kinds = new Map<string, SpyglassFile[]>();
  for (const file of files) {
    const group = kinds.get(file.kind) ?? [];
    group.push(file);
    kinds.set(file.kind, group);
  }
  ctx.globalAlpha = opacity;
  for (const [kind, group] of kinds) {
    ctx.beginPath();
    for (const file of group) {
      ctx.moveTo(file.x + radius, file.y);
      ctx.arc(file.x, file.y, radius, 0, Math.PI * 2);
    }
    ctx.fillStyle = fileInk(kind);
    ctx.fill();
  }
}

function paintFileMark(
  f: SpyglassFile,
  ctx: CanvasRenderingContext2D,
  size: number
) {
  if (f.fileRole === "commons") {
    ctx.beginPath();
    ctx.arc(f.x, f.y, size, 0, Math.PI * 2);
    ctx.stroke();
  } else if (f.fileRole === "junction") {
    ctx.beginPath();
    ctx.moveTo(f.x - size, f.y);
    ctx.lineTo(f.x + size, f.y);
    ctx.moveTo(f.x, f.y - size);
    ctx.lineTo(f.x, f.y + size);
    ctx.stroke();
    ctx.strokeRect(f.x - size / 2, f.y - size / 2, size, size);
  } else if (f.fileRole === "mixed") {
    ctx.fillRect(f.x - size, f.y - size / 2, size * 0.65, size);
    ctx.strokeRect(f.x + size * 0.35, f.y - size / 2, size * 0.65, size);
  } else if (f.fileRole === "unknown") {
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
