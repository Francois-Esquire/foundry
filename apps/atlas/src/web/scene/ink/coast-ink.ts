import type { AtlasData } from "../../types";
import type { InkView } from "../exploration";
import { paintCoastInk } from "../paint-paper";
import type { InkState } from "./state";

/** Every island's coast ink, the selected island's gilded. */
export function paintCoastline(state: InkState): void {
  paintCoasts(state.ctx, state.data, state.view, state.selected);
}

function paintCoasts(
  ctx: CanvasRenderingContext2D,
  data: AtlasData,
  view: InkView | undefined,
  selected: string | null
) {
  for (const territory of data.territories) {
    paintCoastInk(
      ctx,
      territory,
      view?.pixelsPerUnit ?? 1,
      territory.id === selected
    );
  }
}
