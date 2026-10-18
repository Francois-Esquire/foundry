import { dashAt, departureRing, inkStyle } from "../../ladder/ink-ladder";
import { departures } from "../../layout/departures";
import { nearestCoast, seaCurve } from "../../layout/dependency-links";
import { tiltStretch } from "../../view/chart-view";
import { clipToSea } from "../selection-ink";
import type { InkState } from "./state";

/** Where a line meets its target, held back from the coast as selection lines are, in map units. */
const targetClearance = 7;
/** The bead at a line's target end, in screen pixels, as on the selection's lines. */
const beadRadius = 2.2;

/**
 * Departures, from the `placement` lens: a notched ring on each departing
 * file, folder, or single-consumer package, and a dash-dot line from each
 * ranked group to the nearest coast of the package it departs toward,
 * ended by a bead there, as selection lines are,
 * routed as selection lines are, sea ink only and cut around names. Drawn
 * by default. While anything is selected the selection's lines win and no
 * departure line is drawn; the marks stay, being on land.
 */
export function paintDepartures(state: InkState): void {
  const { ctx, data, labels, pixels, selected } = state;
  const { lines, marks } = departures(data);
  if (!marks.length) {
    return;
  }
  const ring = inkStyle("departure");
  // Drawn under the tilt's stretch, so a ring is round on screen and keeps
  // its weight at its foot and crown.
  ctx.save();
  ctx.scale(1, tiltStretch);
  ctx.strokeStyle = ring.hue;
  ctx.lineWidth = ring.weight / pixels;
  ctx.lineCap = "round";
  for (const mark of marks) {
    const radius = departureRing.radius[mark.level] / pixels;
    ctx.beginPath();
    ctx.arc(
      mark.x,
      mark.y / tiltStretch,
      radius,
      -Math.PI / 2 + departureRing.notch / 2,
      (3 * Math.PI) / 2 - departureRing.notch / 2
    );
    ctx.stroke();
  }
  ctx.restore();
  if (selected) {
    return;
  }
  const territories = new Map(data.territories.map((t) => [t.id, t]));
  const pen = inkStyle("departure-line");
  ctx.save();
  clipToSea(ctx, data, labels, pixels);
  ctx.strokeStyle = pen.hue;
  ctx.fillStyle = inkStyle("departure-bead").hue;
  ctx.lineWidth = pen.weight / pixels;
  ctx.setLineDash(dashAt(pen, pixels));
  for (const line of lines) {
    const target = territories.get(line.toward);
    if (!target) {
      continue;
    }
    const from: [number, number] = [line.from.x, line.from.y];
    const curve = seaCurve(from, nearestCoast(from, target), {
      end: targetClearance,
      start: 0,
    });
    ctx.beginPath();
    ctx.moveTo(...curve.start);
    ctx.quadraticCurveTo(...curve.control, ...curve.end);
    ctx.stroke();
    // A bead at the target's end gives the line its direction.
    ctx.beginPath();
    ctx.arc(...curve.end, beadRadius / pixels, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
