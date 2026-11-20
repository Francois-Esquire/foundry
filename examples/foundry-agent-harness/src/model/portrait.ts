import { grain } from "@/model/grain";
import { hud, tones } from "@/model/palette";
import {
  type ArtRow,
  createCanvas,
  etch,
  fill,
  rasterize,
} from "@/model/pixels";

function figure(x: number, y: number, width: number, height: number): string {
  const centre = (width - 1) / 2;
  const head = height * 0.37;
  const reach = height * 0.25;
  const inHead =
    ((x - centre) / (reach * 0.9)) ** 2 + ((y - head) / reach) ** 2 <= 1;
  const inBody =
    ((x - centre) / (width * 0.46)) ** 2 +
      ((y - height * 1.02) / (height * 0.36)) ** 2 <=
    1;
  if (!(inHead || inBody)) {
    return y % 2 ? "#16130d" : "#100e0a";
  }
  return x < centre - reach * 0.3 ? tones.amber.dim : "#5e3d0e";
}

export function portraitArt({
  caption,
  rows,
  width,
}: {
  readonly caption: string;
  readonly rows: number;
  readonly width: number;
}): ArtRow[] {
  const canvas = createCanvas(width, rows, grain);
  const tall = Math.max(rows - 2, 1);
  const view = Math.min(width - 10, tall * 2 + 2);
  const left = Math.floor((width - view) / 2);
  const right = left + view;
  const text = ` ${caption.slice(0, width - 4)} `;
  const textX = Math.floor((width - text.length) / 2);
  fill(canvas, { height: tall * 2, width: view, x: left, y: 0 }, (x, y) =>
    figure(x - left, y, view, tall * 2)
  );
  const slats = { height: tall - 2, y: 1 };
  return rasterize(canvas, [
    ...etch(canvas, { ...slats, width: left - 3, x: 1 }, "▃", hud.iron[0]),
    ...etch(
      canvas,
      { ...slats, width: left - 3, x: right + 2 },
      "▃",
      hud.iron[0]
    ),
    ...etch(canvas, { height: tall, x: right, y: 0 }, "▏", hud.iron[6]),
    ...etch(canvas, { width: view, x: left, y: tall }, "▔", hud.iron[6]),
    ...etch(canvas, { x: textX - 1, y: rows - 1 }, "▐", hud.screen),
    ...etch(canvas, { x: textX + text.length, y: rows - 1 }, "▌", hud.screen),
    { bg: hud.screen, fg: hud.amber, text, x: textX, y: rows - 1 },
  ]);
}
