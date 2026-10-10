import type { ResponsibilityOverlay } from "../responsibility-focus";
import type { AtlasFile, Territory } from "../types";
import { detailLevel } from "./detail-level";
import { dashAt, inkAlpha, inkStyle, inks } from "./ink-ladder";
import { paintComposition } from "./paint-composition";
import { paintScenarioRoutes } from "./paint-scenario-routes";

export function paintResponsibility(
  ctx: CanvasRenderingContext2D,
  territory: Territory,
  overlay: ResponsibilityOverlay,
  pixels: number
) {
  const files = new Map(territory.files.map((f) => [f.id, f]));
  ctx.save();
  ctx.translate(territory.x, territory.y);
  paintComposition(ctx, territory, overlay, pixels);
  paintScenarioRoutes(ctx, territory, overlay, pixels);
  const hint = inkStyle("inspection-hint");
  ctx.strokeStyle = hint.hue;
  ctx.lineWidth = hint.weight / pixels;
  ctx.setLineDash(dashAt(hint, pixels));
  for (const id of overlay.hints ?? []) {
    const file = files.get(id);
    if (!file) {
      continue;
    }
    ctx.beginPath();
    ctx.arc(file.x, file.y, 5 / pixels, 0.3, Math.PI * 1.6);
    ctx.stroke();
  }
  const linkStyle = inkStyle("inspection-link");
  ctx.lineWidth = linkStyle.weight / pixels;
  ctx.strokeStyle = linkStyle.hue;
  ctx.globalAlpha = inkAlpha.inspectionLink;
  ctx.setLineDash(dashAt(linkStyle, pixels));
  for (const link of overlay.links) {
    const a = files.get(link.source),
      b = files.get(link.target);
    if (!(a && b)) {
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = detailLevel(
    pixels,
    (overlay.composition?.marks.length ?? 0) > 0
  ).files;
  paintResponsibilityEntries(overlay, ctx, files, pixels);
  ctx.strokeStyle = inks.inspectionWarning;
  ctx.lineWidth = inkStyle("inspection-notch").weight / pixels;
  for (const id of overlay.pathDisagreement) {
    const file = files.get(id);
    if (!file) {
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(file.x + 2 / pixels, file.y - 2 / pixels);
    ctx.lineTo(file.x + 6 / pixels, file.y - 6 / pixels);
    ctx.stroke();
  }
  const unresolved = inkStyle("inspection-unresolved");
  ctx.lineWidth = unresolved.weight / pixels;
  ctx.setLineDash(dashAt(unresolved, pixels));
  for (const id of overlay.unresolved) {
    const file = files.get(id);
    if (!file) {
      continue;
    }
    const r = 6 / pixels;
    ctx.beginPath();
    ctx.moveTo(file.x, file.y - r);
    ctx.lineTo(file.x + r, file.y);
    ctx.lineTo(file.x, file.y + r);
    ctx.lineTo(file.x - r, file.y);
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}

function paintResponsibilityEntries(
  overlay: ResponsibilityOverlay,
  ctx: CanvasRenderingContext2D,
  files: Map<string, AtlasFile>,
  pixels: number
) {
  for (const [ids, style, radius] of [
    [overlay.related, inkStyle("inspection-related"), 2.5],
    [overlay.members, inkStyle("inspection-focus"), 3.5],
  ] as const) {
    ctx.strokeStyle = style.hue;
    ctx.lineWidth = style.weight / pixels;
    for (const id of ids) {
      const file = files.get(id);
      if (!file) {
        continue;
      }
      ctx.beginPath();
      ctx.arc(file.x, file.y, radius / pixels, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
