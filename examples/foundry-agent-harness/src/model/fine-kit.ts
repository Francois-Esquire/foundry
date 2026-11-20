import { hud } from "@/model/palette";
import {
  type Canvas,
  createFineCanvas,
  fill,
  type Label,
  stamp,
} from "@/model/pixels";

export interface Sheet {
  readonly canvas: Canvas;
  readonly labels: Label[];
}

export interface Cells {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

const [PIT, face, FLECK] = hud.grain;
const [dark, , , , dim, , light] = hud.iron;

export const FACE = face;
export const LIGHT = light;
export const DIM = dim;
export const DARK = dark;
const PIT_CHANCE = 0.08;
const FLECK_SHARE = 0.25;

export function sheet(
  width: number,
  rows: number,
  color: string = FACE
): Sheet {
  return { canvas: createFineCanvas(width, rows, color), labels: [] };
}

export function hline(
  canvas: Canvas,
  x: number,
  y: number,
  width: number,
  color: string
) {
  fill(canvas, { height: 1, width, x, y }, color);
}

export function vline(
  canvas: Canvas,
  x: number,
  y: number,
  height: number,
  color: string
) {
  fill(canvas, { height, width: 1, x, y }, color);
}

export function dotted(
  canvas: Canvas,
  area: {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  },
  color: string
) {
  fill(canvas, area, (x, y) =>
    (x + y) % 2 === 0 ? color : (canvas[y]?.[x] ?? color)
  );
}

export function well(canvas: Canvas, area: Cells, color: string) {
  fill(
    canvas,
    {
      height: area.height * 3,
      width: area.width * 2,
      x: area.x * 2,
      y: area.y * 3,
    },
    color
  );
}

export function ring(canvas: Canvas, area: Cells, top = true) {
  const x = area.x * 2;
  const y = area.y * 3;
  const width = area.width * 2;
  const height = area.height * 3;
  if (height <= 0) {
    return;
  }
  if (top) {
    hline(canvas, x, y - 1, width, DIM);
    dotted(canvas, { height: 1, width, x, y: y - 2 }, DIM);
  }
  vline(canvas, x - 1, y, height, DIM);
  dotted(canvas, { height, width: 1, x: x - 2, y }, DIM);
  vline(canvas, x + width, y, height, LIGHT);
  dotted(canvas, { height, width: 1, x: x + width + 1, y }, LIGHT);
  hline(canvas, x, y + height, width, LIGHT);
  dotted(canvas, { height: 1, width, x, y: y + height + 1 }, LIGHT);
}

export function nicks(canvas: Canvas, area: Cells, color = FACE) {
  const left = area.x * 2;
  const right = (area.x + area.width) * 2 - 1;
  const top = area.y * 3;
  const bottom = (area.y + area.height) * 3 - 1;
  for (const [x, y] of [
    [left, top],
    [right, top],
    [left, bottom],
    [right, bottom],
  ] as const) {
    fill(canvas, { height: 1, width: 1, x, y }, color);
  }
}

export function rivet(canvas: Canvas, x: number, y: number) {
  stamp(canvas, x, y, [".ld.", "lldd", ".ld."], { d: DIM, l: LIGHT });
}

const POINT_LEFT = [".#", "##", ".#"];
const POINT_RIGHT = ["#.", "##", "#."];

export function pointed(
  canvas: Canvas,
  cell: { readonly x: number; readonly y: number },
  side: "left" | "right",
  inks: { readonly ground: string; readonly ink: string }
) {
  stamp(
    canvas,
    cell.x * 2,
    cell.y * 3,
    side === "left" ? POINT_LEFT : POINT_RIGHT,
    { ".": inks.ground, "#": inks.ink }
  );
}

function noise(x: number, y: number): number {
  const value = Math.sin(x * 12.9898 + y * 78.233) * 43_758.5453;
  return value - Math.floor(value);
}

function untouched(canvas: Canvas, x: number, y: number): boolean {
  return [0, 1, 2].every(
    (line) =>
      canvas[y + line]?.[x] === FACE && canvas[y + line]?.[x + 1] === FACE
  );
}

export function pit(canvas: Canvas) {
  const width = canvas[0]?.length ?? 0;
  for (let y = 0; y + 2 < canvas.length; y += 3) {
    for (let x = 0; x + 1 < width; x += 2) {
      if (untouched(canvas, x, y)) {
        const tone = noise(x + 0.5, y + 0.5) < FLECK_SHARE ? FLECK : PIT;
        fill(canvas, { height: 3, width: 2, x, y }, (px, py) =>
          noise(px, py) < PIT_CHANCE ? tone : FACE
        );
      }
    }
  }
}
