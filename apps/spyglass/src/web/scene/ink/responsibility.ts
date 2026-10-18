import type { Territory } from "../../data/types";
import type { ResponsibilityOverlay } from "../../layout/responsibility-focus";
import { paintResponsibility } from "../paint-responsibility";
import type { InkState } from "./state";

/** The architectural overlay of the selected island's responsibility. */
export function paintResponsibilityOverlay(state: InkState): void {
  const { responsibility } = state;
  paintSelectedResponsibility(
    responsibility,
    responsibility && state.regions.get(responsibility.territoryId),
    state.selected,
    state.ctx,
    state.pixels
  );
}

function paintSelectedResponsibility(
  responsibility: ResponsibilityOverlay | null,
  responsibilityTerritory: Territory | null | undefined,
  selected: string | null,
  ctx: CanvasRenderingContext2D,
  pixels: number
) {
  if (
    responsibility &&
    responsibilityTerritory &&
    selected === responsibility.territoryId
  ) {
    paintResponsibility(ctx, responsibilityTerritory, responsibility, pixels);
  }
}
