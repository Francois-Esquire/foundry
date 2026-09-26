import { detailLevel } from "./detail-level";
import { paintComposition } from "./paint-composition";
import { paintScenarioRoutes } from "./paint-scenario-routes";
import type { ResponsibilityOverlay } from "./responsibility-focus";
import type { Territory } from "./types";

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
  ctx.strokeStyle = "#875222";
  for (const id of overlay.hints ?? []) {
    const file = files.get(id);
    if (!file) {
      continue;
    }
    ctx.beginPath();
    ctx.arc(file.x, file.y, 5 / pixels, 0.3, Math.PI * 1.6);
    ctx.stroke();
  }
  ctx.lineWidth = 1.2 / pixels;
  ctx.strokeStyle = "#874b37a0";
  ctx.setLineDash([3 / pixels, 4 / pixels]);
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
  for (const [ids, color, radius] of [
    [overlay.related, "#587575", 2.5],
    [overlay.members, "#875222", 3.5],
  ] as const) {
    ctx.strokeStyle = color;
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
  ctx.strokeStyle = "#963f32";
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
  ctx.lineWidth = 1.6 / pixels;
  ctx.setLineDash([3 / pixels, 2 / pixels]);
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
