import { inks } from "../ink-ladder";
import type { InkState } from "./state";

/** The sea's name and the chart's one caveat, set under the southern margin. */
export function paintSeaCaption({ ctx, data }: InkState): void {
  ctx.fillStyle = inks.seaCaption;
  ctx.textAlign = "center";
  ctx.font = "italic 14px Georgia";
  ctx.fillText("The dependency sea", 0, data.height / 2 - 38);
  ctx.font = "6px AtlasBody";
  ctx.fillText(
    "DISTANCE EXPRESSES RELATIONSHIP · NOT PHYSICAL SCALE",
    0,
    data.height / 2 - 22
  );
}
