import { dependencyPen } from "../data/bindings";
import type { SpyglassData } from "../data/types";
import { dashAt, enteredAt, inkStyle, inks } from "../ladder/ink-ladder";
import { dependencyLinks } from "../layout/dependency-links";
import { selectionRing } from "../layout/selection-ring";
import type { MapLabel } from "./exploration";
import { traceLand } from "./paint-paper";

/**
 * Clips `ctx` to the sea, cut around every name, so that lines drawn after
 * pass beneath islands and leave names clear. Each name is its own clip:
 * cut in the one even-odd path with the land, a name over land, or over
 * another name, would open the clip there again. The caller restores.
 */
export function clipToSea(
  ctx: CanvasRenderingContext2D,
  data: SpyglassData,
  labels: readonly MapLabel[],
  pixels: number
) {
  const sheet = () =>
    ctx.rect(-data.width, -data.height, data.width * 2, data.height * 2);
  ctx.beginPath();
  sheet();
  traceLand(ctx, data);
  ctx.clip("evenodd");
  for (const label of labels) {
    ctx.beginPath();
    sheet();
    ctx.rect(
      label.x - label.width / 2 - 4 / pixels,
      label.y - label.height - 4 / pixels,
      label.width + 8 / pixels,
      label.height + (label.caption ? 18 : 8) / pixels
    );
    ctx.clip("evenodd");
  }
}

/**
 * Selection ink, the ladder's strongest: a ring around the selected island
 * and dashed curves to the packages it imports from (dots from its
 * dependents), all in the selection ink.
 * Lines pass beneath other islands; they are sea ink only.
 */
export function paintSelectionInk(
  ctx: CanvasRenderingContext2D,
  data: SpyglassData,
  selected: string | null,
  pixels: number,
  labels: readonly MapLabel[] = []
) {
  const territory = data.territories.find((t) => t.id === selected);
  if (!(territory && selected)) {
    return;
  }
  const routes = dependencyLinks(data, selected);
  const strongest = Math.max(1, ...routes.map((link) => link.route.weight));
  ctx.save();
  clipToSea(ctx, data, labels, pixels);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = inks.selection;
  const imports = inkStyle("selection-imports");
  const importers = inkStyle("selection-importers");
  for (const link of routes) {
    ctx.lineWidth = dependencyPen(link.route.weight, strongest) / pixels;
    ctx.setLineDash(dashAt(link.outgoing ? imports : importers, pixels));
    ctx.beginPath();
    ctx.moveTo(...link.start);
    ctx.quadraticCurveTo(...link.control, ...link.end);
    ctx.stroke();
    ctx.setLineDash([]);
    // A small bead marks the other package's end of each line.
    ctx.beginPath();
    ctx.arc(...link.end, 2.2 / pixels, 0, Math.PI * 2);
    ctx.fillStyle = inks.selection;
    ctx.fill();
  }
  // Once the island is entered the breadcrumb carries the selection, and the
  // ring steps down to the file rung so it does not read as another coast.
  const ringStyle = inkStyle(pixels < enteredAt ? "selection" : "entered-ring");
  ctx.setLineDash([]);
  ctx.strokeStyle = ringStyle.hue;
  ctx.lineWidth = ringStyle.weight / pixels;
  for (const ring of selectionRing(territory)) {
    ctx.beginPath();
    for (const [index, [x, y]] of ring.entries()) {
      if (index) {
        ctx.lineTo(x, y);
      } else {
        ctx.moveTo(x, y);
      }
    }
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}
