import { placementKey } from "../../data/resolve";
import { departureRing, inkStyle } from "../../ladder/ink-ladder";
import { departures } from "../../layout/departures";
import { tiltStretch as stretch } from "../../view/chart-view";
import type { InkState } from "./state";

/**
 * The departures a chosen domain explains, their domain label
 * `shares-domain` with it among the shared: the notch of each ring is
 * closed in the domain's ink, heavier than the ring, so the ring still
 * reads as a departure and the plug as the domain's. A domain departure
 * takes nothing more.
 */
export function paintDomainDepartures(state: InkState): void {
  const { ctx, data, domain, pixels } = state;
  if (!domain?.explained.size) {
    return;
  }
  const pen = inkStyle("domain-explained");
  // Under the departures' own stretch, so the plug meets its ring.
  ctx.save();
  ctx.scale(1, stretch);
  ctx.strokeStyle = pen.hue;
  ctx.lineWidth = pen.weight / pixels;
  ctx.lineCap = "butt";
  ctx.setLineDash([]);
  for (const mark of departures(data).marks) {
    if (
      mark.frame !== domain.frame ||
      !domain.explained.has(placementKey(mark))
    ) {
      continue;
    }
    ctx.beginPath();
    ctx.arc(
      mark.x,
      mark.y / stretch,
      departureRing.radius[mark.level] / pixels,
      -Math.PI / 2 - departureRing.notch / 2,
      -Math.PI / 2 + departureRing.notch / 2
    );
    ctx.stroke();
  }
  ctx.restore();
}
