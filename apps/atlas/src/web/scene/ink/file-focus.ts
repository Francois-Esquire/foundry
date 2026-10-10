import type { AtlasData } from "../../types";
import type { InkState } from "./state";

/** The selected file's amber ring, above every other mark. */
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
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(0, 0, 9 / pixels, 0, Math.PI * 2);
  ctx.strokeStyle = "#faf4e4";
  ctx.lineWidth = 5 / pixels;
  ctx.stroke();
  ctx.strokeStyle = "#875222";
  ctx.lineWidth = 2 / pixels;
  ctx.stroke();
  ctx.fillStyle = "#875222";
  ctx.fillRect(-2 / pixels, -2 / pixels, 4 / pixels, 4 / pixels);
  ctx.restore();
}
