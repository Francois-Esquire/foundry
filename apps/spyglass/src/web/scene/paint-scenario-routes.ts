import type { Territory } from "../data/types";
import { dashAt, inkAlpha, inkStyle } from "../ladder/ink-ladder";
import type { ResponsibilityOverlay } from "../layout/responsibility-focus";
import type { RouteEndpoint } from "../layout/scenario-routes";

export function paintScenarioRoutes(
  ctx: CanvasRenderingContext2D,
  territory: Territory,
  overlay: ResponsibilityOverlay,
  pixels: number
) {
  const { routes } = overlay;
  if (!routes) {
    return;
  }
  const files = new Map(territory.files.map((file) => [file.id, file]));
  const point = (endpoint: RouteEndpoint) => {
    if (endpoint.kind === "file") {
      return files.get(endpoint.id);
    }
    const members =
      routes.scopes
        .find((scope) => scope.id === endpoint.id)
        ?.files.flatMap((id) => files.get(id) ?? []) ?? [];
    return members.length
      ? {
          x: members.reduce((sum, file) => sum + file.x, 0) / members.length,
          y: members.reduce((sum, file) => sum + file.y, 0) / members.length,
        }
      : undefined;
  };
  ctx.save();
  for (const [links, style, alpha] of [
    [routes.baseline, inkStyle("scenario-baseline"), inkAlpha.scenarioBaseline],
    [routes.proposed, inkStyle("scenario-proposed"), routes.progress],
  ] as const) {
    ctx.strokeStyle = style.hue;
    ctx.lineWidth = style.weight / pixels;
    ctx.globalAlpha = alpha;
    ctx.setLineDash(dashAt(style, pixels));
    for (const route of links.slice(0, 64)) {
      const source = point(route.source),
        target = point(route.target);
      if (!(source && target)) {
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
      ctx.stroke();
      if (route.target.kind === "responsibility") {
        ctx.beginPath();
        ctx.arc(target.x, target.y, 6 / pixels, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        const angle = Math.atan2(target.y - source.y, target.x - source.x);
        ctx.beginPath();
        ctx.moveTo(
          target.x - (Math.cos(angle - 0.5) * 5) / pixels,
          target.y - (Math.sin(angle - 0.5) * 5) / pixels
        );
        ctx.lineTo(target.x, target.y);
        ctx.lineTo(
          target.x - (Math.cos(angle + 0.5) * 5) / pixels,
          target.y - (Math.sin(angle + 0.5) * 5) / pixels
        );
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}
