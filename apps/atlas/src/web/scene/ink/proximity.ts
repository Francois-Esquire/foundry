import { drawnTies, proximities } from "../../proximity";
import { tiltStretch } from "../exploration";
import { closeMark, dashAt, enteredAt, inkStyle } from "../ink-ladder";
import { traceLand } from "../paint-paper";
import type { InkState } from "./state";

/** A tie's bead, in screen pixels. */
const beadRadius = 1.8;

/**
 * Proximity, at island zoom only, so the overview stays the departures':
 * ties for what is related but apart (a dotted tie from a file to its
 * responsibility's folder, a dashed one between two files that change
 * together), at most a few on each island, or all of a selected file's;
 * and two arcs set apart on each folder whose files serve unrelated
 * responsibilities. All of it is clipped to land, where no departure or
 * selection line runs.
 */
export function paintProximity(state: InkState): void {
  const { ctx, data, fileId, pixels } = state;
  if (pixels < enteredAt) {
    return;
  }
  // Ties stay on land, even where a coast curves in between their ends.
  ctx.save();
  ctx.beginPath();
  traceLand(ctx, data);
  ctx.clip("evenodd");
  const bead = inkStyle("proximity-bead");
  ctx.fillStyle = bead.hue;
  ctx.lineCap = "round";
  for (const territory of data.territories) {
    for (const tie of drawnTies(data, territory.id, fileId)) {
      const pen = inkStyle(
        tie.kind === "apart" ? "proximity-apart" : "proximity-co-change"
      );
      ctx.strokeStyle = pen.hue;
      ctx.lineWidth = pen.weight / pixels;
      ctx.setLineDash(dashAt(pen, pixels));
      ctx.beginPath();
      ctx.moveTo(tie.from.x, tie.from.y);
      ctx.lineTo(tie.to.x, tie.to.y);
      ctx.stroke();
      ctx.setLineDash([]);
      const ends = tie.kind === "apart" ? [tie.to] : [tie.from, tie.to];
      for (const end of ends) {
        ctx.beginPath();
        ctx.arc(end.x, end.y, beadRadius / pixels, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  const sides = inkStyle("proximity-close");
  ctx.strokeStyle = sides.hue;
  ctx.lineWidth = sides.weight / pixels;
  ctx.setLineDash([]);
  const radius = closeMark.radius / pixels;
  const apart = closeMark.apart / pixels;
  // Under the tilt's stretch, so the arcs are round on screen.
  ctx.scale(1, tiltStretch);
  for (const mark of proximities(data).marks) {
    // "( )": two arcs set apart, one for each side of the folder.
    for (const side of [-1, 1]) {
      const facing = side < 0 ? Math.PI : 0;
      ctx.beginPath();
      ctx.arc(
        mark.x + side * apart,
        mark.y / tiltStretch,
        radius,
        facing - closeMark.sweep,
        facing + closeMark.sweep
      );
      ctx.stroke();
    }
  }
  ctx.restore();
}
