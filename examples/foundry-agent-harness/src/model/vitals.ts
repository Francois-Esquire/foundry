import { drawNumerals, numeralWidth } from "@/model/numerals";
import { hud, type Tone } from "@/model/palette";
import {
  type ArtRow,
  createCanvas,
  type Label,
  rasterize,
} from "@/model/pixels";

const SEGMENT = "▊";
const GHOST = "#1c1a17";
const FIGURE = 14;

function clamp(level: number): number {
  return Math.min(Math.max(level, 0), 1);
}

function gaugeLabels(
  cells: number,
  level: number,
  tone: Tone,
  at: { readonly x: number; readonly y: number } = { x: 0, y: 0 }
): Label[] {
  const lit = Math.round(clamp(level) * cells);
  const body = Math.max(lit - 1, 0);
  return [
    { bg: hud.shade, fg: tone.lit, text: SEGMENT.repeat(body), ...at },
    {
      bg: hud.shade,
      fg: tone.glow,
      text: SEGMENT.repeat(lit - body),
      x: at.x + body,
      y: at.y,
    },
    {
      bg: hud.shade,
      fg: hud.iron[2],
      text: SEGMENT.repeat(cells - lit),
      x: at.x + lit,
      y: at.y,
    },
  ];
}

export function gaugeArt(cells: number, level: number, tone: Tone): ArtRow[] {
  return rasterize(
    createCanvas(cells, 1, () => hud.shade),
    gaugeLabels(cells, level, tone)
  );
}

export function statTileArt({
  detail = "",
  label,
  level,
  tone,
  width,
}: {
  readonly detail?: string;
  readonly label: string;
  readonly level: number;
  readonly tone: Tone;
  readonly width: number;
}): ArtRow[] {
  const canvas = createCanvas(width, 3, () => hud.screen);
  const figure = String(Math.round(clamp(level) * 100));
  const reach = numeralWidth(figure);
  const side = Math.max(reach + 1, FIGURE);
  const room = Math.max(width - side, 0);
  drawNumerals(
    canvas,
    { x: 0, y: 0 },
    figure,
    [tone.glow, tone.lit, tone.lit, tone.lit, tone.dim],
    GHOST
  );
  const percent: Label[] =
    reach + 2 <= side
      ? [{ bg: hud.screen, fg: tone.dim, text: "%", x: reach + 1, y: 2 }]
      : [];
  return rasterize(canvas, [
    ...percent,
    { bg: hud.screen, fg: hud.text, text: label.slice(0, room), x: side, y: 0 },
    { bg: hud.screen, fg: hud.dim, text: detail.slice(0, room), x: side, y: 1 },
    ...gaugeLabels(room, level, tone, { x: side, y: 2 }),
  ]);
}
