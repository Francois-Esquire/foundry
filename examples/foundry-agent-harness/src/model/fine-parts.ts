import {
  DARK,
  DIM,
  FACE,
  hline,
  LIGHT,
  pit,
  pointed,
  type Sheet,
  sheet,
  vline,
} from "@/model/fine-kit";
import { TALL_WIDTH, tallNumerals } from "@/model/numerals";
import { hud, type Tone, tones } from "@/model/palette";
import { type ArtRow, fill, rasterizeFine, stamp } from "@/model/pixels";
import { fitSteps, STEP_FACES, STEP_LINK, type Step } from "@/model/steps";

const VENT = 7;
const FIGURE = 11;
const SEGMENT = 3;
const GROUND = "#100e0a";
const HEAD_AT = 0.34;
const HEAD_TALL = 0.21;
const ASPECT = 4 / 3;

function done({ canvas, labels }: Sheet): ArtRow[] {
  return rasterizeFine(canvas, labels);
}

export function fineStepStrip(steps: readonly Step[], width: number): Sheet {
  const art = sheet(width, 3);
  const { canvas, labels } = art;
  hline(canvas, 0, 0, width * 2, LIGHT);
  hline(canvas, 0, 8, width * 2, DIM);
  let x = 1;
  for (const [index, item] of fitSteps(steps, width - 2).entries()) {
    const look = STEP_FACES[item.state];
    const size = [...item.text].length;
    if (index > 0) {
      hline(canvas, (x - STEP_LINK) * 2, 4, STEP_LINK * 2, DARK);
    }
    fill(canvas, { height: 2, width: size * 2, x: x * 2, y: 1 }, look.upper);
    fill(canvas, { height: 3, width: size * 2, x: x * 2, y: 3 }, look.face);
    fill(canvas, { height: 2, width: size * 2, x: x * 2, y: 6 }, look.lower);
    labels.push({
      bg: look.face,
      bold: item.state === "active",
      fg: look.ink,
      text: item.text,
      x,
      y: 1,
    });
    x += size + STEP_LINK;
  }
  const vent = width - VENT - 2;
  if (vent > x) {
    fill(canvas, { height: 3, width: VENT * 2, x: vent * 2, y: 3 }, (px) =>
      px % 2 === 0 ? tones.amber.lit : DARK
    );
  }
  pit(canvas);
  return art;
}

export function fineStepStripArt(
  steps: readonly Step[],
  width: number
): ArtRow[] {
  return done(fineStepStrip(steps, width));
}

function clamp(level: number): number {
  return Math.min(Math.max(level, 0), 1);
}

function gauge(
  { canvas }: Sheet,
  at: { readonly cells: number; readonly x: number; readonly y: number },
  level: number,
  tone: Tone
) {
  const lit = Math.round(clamp(level) * at.cells);
  fill(
    canvas,
    { height: 3, width: at.cells * 2, x: at.x * 2, y: at.y * 3 },
    (px) => {
      const offset = px - at.x * 2;
      const cell = Math.floor(offset / 2);
      if (offset % SEGMENT === SEGMENT - 1) {
        return hud.shade;
      }
      if (cell >= lit) {
        return hud.iron[2];
      }
      return cell === lit - 1 ? tone.glow : tone.lit;
    }
  );
}

export function fineGauge(cells: number, level: number, tone: Tone): Sheet {
  const art = sheet(cells, 1, hud.shade);
  gauge(art, { cells, x: 0, y: 0 }, level, tone);
  return art;
}

export function fineGaugeArt(
  cells: number,
  level: number,
  tone: Tone
): ArtRow[] {
  return done(fineGauge(cells, level, tone));
}

export function fineStatTile({
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
}): Sheet {
  const art = sheet(width, 3, hud.screen);
  const { canvas, labels } = art;
  const glyphs = tallNumerals(String(Math.round(clamp(level) * 100)));
  const ramp = [tone.glow, tone.lit, tone.lit];
  for (const [index, glyph] of glyphs.entries()) {
    for (const [row, line] of glyph.entries()) {
      stamp(canvas, index * (TALL_WIDTH + 1), row, [line], {
        "#": ramp[Math.floor(row / 3)] ?? tone.lit,
      });
    }
  }
  const reach = Math.ceil((glyphs.length * (TALL_WIDTH + 1) - 1) / 2);
  const room = Math.max(width - FIGURE, 0);
  if (reach + 1 < FIGURE) {
    labels.push({ bg: hud.screen, fg: tone.dim, text: "%", x: reach, y: 2 });
  }
  labels.push(
    {
      bg: hud.screen,
      fg: hud.text,
      text: [...label].slice(0, room).join(""),
      x: FIGURE,
      y: 0,
    },
    {
      bg: hud.screen,
      fg: hud.dim,
      text: [...detail].slice(0, room).join(""),
      x: FIGURE,
      y: 1,
    }
  );
  gauge(art, { cells: room, x: FIGURE, y: 2 }, level, tone);
  return art;
}

export function fineStatTileArt(
  tile: Parameters<typeof fineStatTile>[0]
): ArtRow[] {
  return done(fineStatTile(tile));
}

function shade(x: number, y: number, depth: number): boolean {
  if (depth < 0.52) {
    return true;
  }
  if (depth < 0.7) {
    return !(x % 2 === 0 && y % 2 === 0);
  }
  return (x + y) % 2 === 0;
}

function bust(x: number, y: number, width: number, height: number): boolean {
  const centre = (width - 1) / 2;
  const tall = height * HEAD_TALL;
  const wide = tall * ASPECT;
  const head = height * HEAD_AT;
  const across = (x - centre) / wide;
  const body = (x - centre) / (width * 0.47);
  if (across ** 2 + ((y - head) / tall) ** 2 <= 1) {
    return shade(x, y, across * 0.5 + 0.5);
  }
  if (body ** 2 + ((y - height * 1.08) / (height * 0.4)) ** 2 <= 1) {
    return shade(x, y, body * 0.5 + 0.5);
  }
  return (
    Math.abs(x - centre) <= wide * 0.5 &&
    y > head &&
    y < height * 0.78 &&
    shade(x, y, 1)
  );
}

export function finePortrait({
  caption,
  rows,
  width,
}: {
  readonly caption: string;
  readonly rows: number;
  readonly width: number;
}): Sheet {
  const art = sheet(width, rows);
  const { canvas, labels } = art;
  const tall = Math.max(rows - 2, 1);
  const view = Math.min(width - 10, tall * 2);
  const left = Math.floor((width - view) / 2);
  const right = left + view;
  fill(
    canvas,
    { height: tall * 3, width: view * 2, x: left * 2, y: 0 },
    (x, y) =>
      bust(x - left * 2, y, view * 2, tall * 3) ? tones.amber.dim : GROUND
  );
  vline(canvas, left * 2 - 1, 0, tall * 3, DIM);
  vline(canvas, right * 2, 0, tall * 3, LIGHT);
  hline(canvas, left * 2, tall * 3, view * 2, LIGHT);
  for (let row = 1; row < tall - 1; row += 1) {
    hline(canvas, 2, row * 3 + 1, (left - 3) * 2, DARK);
    hline(canvas, (right + 2) * 2, row * 3 + 1, (left - 3) * 2, DARK);
  }
  const text = ` ${[...caption].slice(0, width - 4).join("")} `;
  const at = { x: Math.floor((width - [...text].length) / 2), y: rows - 1 };
  const inks = { ground: FACE, ink: hud.screen };
  pointed(canvas, { x: at.x - 1, y: at.y }, "left", inks);
  pointed(canvas, { x: at.x + [...text].length, y: at.y }, "right", inks);
  labels.push({ bg: hud.screen, fg: hud.amber, text, ...at });
  pit(canvas);
  return art;
}

export function finePortraitArt(
  bay: Parameters<typeof finePortrait>[0]
): ArtRow[] {
  return done(finePortrait(bay));
}
