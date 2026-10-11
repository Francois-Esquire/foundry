import type { AtlasData } from "../../types";
import { tiltStretch } from "../exploration";
import { inkStyle, inks } from "../ink-ladder";
import type { InkState } from "./state";

/** The selected file's ring, above every other mark, round on screen under the tilt's stretch. */
export function paintFocusedFile(state: InkState): void {
  paintFileFocus(
    state.ctx,
    state.data,
    state.selected,
    state.fileId,
    state.pixels
  );
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
  ctx.scale(1, tiltStretch);
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(0, 0, 9 / pixels, 0, Math.PI * 2);
  ctx.strokeStyle = inks.focusHalo;
  ctx.lineWidth = inkStyle("focus-halo").weight / pixels;
  ctx.stroke();
  ctx.strokeStyle = inks.selection;
  ctx.lineWidth = 2 / pixels;
  ctx.stroke();
  ctx.fillStyle = inks.selection;
  ctx.fillRect(-2 / pixels, -2 / pixels, 4 / pixels, 4 / pixels);
  ctx.restore();
}
