import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { spawn } from "bun";
import { HEALTH, POSES, type Pose, SPRITE_SIZE } from "../src/model/sprite";

const ROOT = resolve(import.meta.dirname, "..");
const ART = resolve(ROOT, "art");
const OUT = resolve(ROOT, "src/model/sprites");
const DIGITS = "0123456789abcdefghijklmnopqrstuv";
const SAMPLED_COLOURS = 28;
const EFFECT_COLOURS: readonly Rgb[] = [
  [214, 36, 28],
  [122, 16, 20],
  [255, 244, 200],
  [255, 196, 60],
];
const PATCH_THRESHOLD = 45;
const WHITE = 235;
const INSET = 14;
const HEADROOM = 0.45;
const SEARCH = 6;
const SAMPLE_STEP = 3;
const MIN_PANEL = 100;
const COLUMN_FILL = 0.04;
const ROW_FILL = 0.2;
const PNG_HEADER = 8;
const CHUNK_OVERHEAD = 12;
const BASE = /^([a-z]+)\.png$/;

type Rgb = readonly [number, number, number];

interface Image {
  readonly data: Uint8Array;
  readonly height: number;
  readonly width: number;
}

interface Panel {
  readonly side: number;
  readonly x: number;
  readonly y: number;
}

function paeth(left: number, up: number, corner: number): number {
  const estimate = left + up - corner;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toCorner = Math.abs(estimate - corner);
  if (toLeft <= toUp && toLeft <= toCorner) {
    return left;
  }
  return toUp <= toCorner ? up : corner;
}

function predict(
  filter: number,
  left: number,
  up: number,
  corner: number
): number {
  if (filter === 1) {
    return left;
  }
  if (filter === 2) {
    return up;
  }
  if (filter === 3) {
    return Math.floor((left + up) / 2);
  }
  return filter === 4 ? paeth(left, up, corner) : 0;
}

function unfilter(
  raw: Uint8Array,
  width: number,
  height: number,
  channels: number
): Uint8Array {
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    for (let x = 0; x < stride; x += 1) {
      const at = y * stride + x;
      const left = x >= channels ? (out[at - channels] ?? 0) : 0;
      const up = y > 0 ? (out[at - stride] ?? 0) : 0;
      const corner =
        x >= channels && y > 0 ? (out[at - stride - channels] ?? 0) : 0;
      const value = raw[y * (stride + 1) + 1 + x] ?? 0;
      out[at] = (value + predict(filter, left, up, corner)) % 256;
    }
  }
  return out;
}

function decode(name: string, file: Buffer): Image {
  const width = file.readUInt32BE(PNG_HEADER + 8);
  const height = file.readUInt32BE(PNG_HEADER + 12);
  const depth = file[PNG_HEADER + 16];
  const colour = file[PNG_HEADER + 17];
  const interlace = file[PNG_HEADER + 20];
  if (depth !== 8 || !(colour === 2 || colour === 6) || interlace !== 0) {
    throw new Error(`${name}: expected an 8-bit RGB or RGBA PNG`);
  }
  const channels = colour === 2 ? 3 : 4;
  const parts: Buffer[] = [];
  let offset = PNG_HEADER;
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    if (file.toString("latin1", offset + 4, offset + 8) === "IDAT") {
      parts.push(file.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + CHUNK_OVERHEAD;
  }
  const pixels = unfilter(
    inflateSync(Buffer.concat(parts)),
    width,
    height,
    channels
  );
  const data = new Uint8Array(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      data[pixel * 3 + channel] = pixels[pixel * channels + channel] ?? 0;
    }
  }
  return { data, height, width };
}

async function load(file: string): Promise<Image> {
  return decode(file, await readFile(resolve(ART, file)));
}

function isWhite(data: Uint8Array, pixel: number): boolean {
  return (
    (data[pixel * 3] ?? 0) > WHITE &&
    (data[pixel * 3 + 1] ?? 0) > WHITE &&
    (data[pixel * 3 + 2] ?? 0) > WHITE
  );
}

function runs(flags: readonly boolean[]): [number, number][] {
  const found: [number, number][] = [];
  let start = -1;
  flags.forEach((flag, index) => {
    if (flag && start < 0) {
      start = index;
    }
    if (!flag && start >= 0) {
      found.push([start, index]);
      start = -1;
    }
  });
  if (start >= 0) {
    found.push([start, flags.length]);
  }
  return found;
}

function inked(image: Image, along: "column" | "row", index: number): number {
  const length = along === "column" ? image.height : image.width;
  let count = 0;
  for (let step = 0; step < length; step += 1) {
    const pixel =
      along === "column"
        ? step * image.width + index
        : index * image.width + step;
    if (!isWhite(image.data, pixel)) {
      count += 1;
    }
  }
  return count;
}

function panels(name: string, image: Image): Panel[] {
  const columns = runs(
    Array.from(
      { length: image.width },
      (_, x) => inked(image, "column", x) > image.height * COLUMN_FILL
    )
  )
    .filter(([from, to]) => to - from > MIN_PANEL)
    .slice(0, HEALTH.length);
  const [band] = runs(
    Array.from(
      { length: image.height },
      (_, y) => inked(image, "row", y) > image.width * ROW_FILL
    )
  ).sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
  if (columns.length !== HEALTH.length || band === undefined) {
    throw new Error(
      `${name}: expected ${HEALTH.length} panels in one row, found ${columns.length}`
    );
  }
  const [top, bottom] = band;
  return columns.map(([from, to]) => {
    const side = Math.min(to - from, bottom - top) - INSET * 2;
    return {
      side,
      x: Math.floor((from + to) / 2 - side / 2),
      y: top + INSET + Math.floor((bottom - top - INSET * 2 - side) * HEADROOM),
    };
  });
}

function crop(image: Image, panel: Panel, dx = 0, dy = 0): Image {
  const { side } = panel;
  const data = new Uint8Array(side * side * 3);
  for (let y = 0; y < side; y += 1) {
    const from = ((panel.y + dy + y) * image.width + panel.x + dx) * 3;
    data.set(image.data.subarray(from, from + side * 3), y * side * 3);
  }
  const seen = new Uint8Array(side * side);
  const stack: number[] = [];
  for (let edge = 0; edge < side; edge += 1) {
    stack.push(
      edge,
      (side - 1) * side + edge,
      edge * side,
      edge * side + side - 1
    );
  }
  while (stack.length > 0) {
    const pixel = stack.pop() ?? 0;
    if (seen[pixel] === 1 || !isWhite(data, pixel)) {
      continue;
    }
    seen[pixel] = 1;
    data.fill(0, pixel * 3, pixel * 3 + 3);
    const x = pixel % side;
    if (x > 0) {
      stack.push(pixel - 1);
    }
    if (x < side - 1) {
      stack.push(pixel + 1);
    }
    if (pixel >= side) {
      stack.push(pixel - side);
    }
    if (pixel < side * (side - 1)) {
      stack.push(pixel + side);
    }
  }
  return { data, height: side, width: side };
}

function average(image: Image, x: number, y: number): Rgb {
  const side = image.width;
  const top = Math.floor((y * side) / SPRITE_SIZE);
  const bottom = Math.max(top + 1, Math.floor(((y + 1) * side) / SPRITE_SIZE));
  const left = Math.floor((x * side) / SPRITE_SIZE);
  const right = Math.max(left + 1, Math.floor(((x + 1) * side) / SPRITE_SIZE));
  let red = 0;
  let green = 0;
  let blue = 0;
  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) {
      const at = (row * side + column) * 3;
      red += image.data[at] ?? 0;
      green += image.data[at + 1] ?? 0;
      blue += image.data[at + 2] ?? 0;
    }
  }
  const count = (bottom - top) * (right - left);
  return [
    Math.round(red / count),
    Math.round(green / count),
    Math.round(blue / count),
  ];
}

function shrink(image: Image): Rgb[] {
  return Array.from({ length: SPRITE_SIZE * SPRITE_SIZE }, (_, pixel) =>
    average(image, pixel % SPRITE_SIZE, Math.floor(pixel / SPRITE_SIZE))
  );
}

function distance(a: Rgb, b: Rgb): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function mismatch(a: Image, b: Image): number {
  let total = 0;
  for (let y = 0; y < a.height; y += SAMPLE_STEP) {
    for (let x = 0; x < a.width; x += SAMPLE_STEP) {
      const at = (y * a.width + x) * 3;
      total += Math.hypot(
        (a.data[at] ?? 0) - (b.data[at] ?? 0),
        (a.data[at + 1] ?? 0) - (b.data[at + 1] ?? 0),
        (a.data[at + 2] ?? 0) - (b.data[at + 2] ?? 0)
      );
    }
  }
  return total;
}

function widest(box: readonly Rgb[]): { axis: 0 | 1 | 2; score: number } {
  let best: { axis: 0 | 1 | 2; score: number } = { axis: 0, score: -1 };
  for (const axis of [0, 1, 2] as const) {
    let low = 255;
    let high = 0;
    for (const colour of box) {
      low = Math.min(low, colour[axis]);
      high = Math.max(high, colour[axis]);
    }
    const score = (high - low) * Math.sqrt(box.length);
    if (score > best.score) {
      best = { axis, score };
    }
  }
  return best;
}

function medianCut(colours: readonly Rgb[], count: number): Rgb[][] {
  const boxes: Rgb[][] = [[...colours]];
  while (boxes.length < count) {
    let pick = 0;
    let split = widest(boxes[0] ?? []);
    boxes.forEach((box, index) => {
      const candidate = widest(box);
      if (candidate.score > split.score) {
        pick = index;
        split = candidate;
      }
    });
    const { axis } = split;
    const sorted = (boxes[pick] ?? [])
      .slice()
      .sort((a, b) => a[axis] - b[axis]);
    if (sorted.length < 2) {
      break;
    }
    const half = Math.floor(sorted.length / 2);
    boxes.splice(pick, 1, sorted.slice(0, half), sorted.slice(half));
  }
  return boxes;
}

function mean(box: readonly Rgb[]): Rgb {
  const sum = box.reduce<Rgb>(
    (total, colour) => [
      total[0] + colour[0],
      total[1] + colour[1],
      total[2] + colour[2],
    ],
    [0, 0, 0]
  );
  return [
    Math.round(sum[0] / box.length),
    Math.round(sum[1] / box.length),
    Math.round(sum[2] / box.length),
  ];
}

function paletteOf(sprites: readonly Rgb[][]): Rgb[] {
  const sampled = medianCut(sprites.flat(), SAMPLED_COLOURS)
    .map(mean)
    .sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  return [...sampled, ...EFFECT_COLOURS];
}

function nearest(palette: readonly Rgb[], colour: Rgb): number {
  let best = 0;
  let closest = Number.POSITIVE_INFINITY;
  palette.forEach((candidate, index) => {
    const gap = distance(colour, candidate);
    if (gap < closest) {
      closest = gap;
      best = index;
    }
  });
  return best;
}

function digit(value: number): string {
  return DIGITS[value] ?? "0";
}

function hex(colour: Rgb): string {
  return `#${colour.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function align(base: Image, pose: Image, panel: Panel): Image {
  let best = crop(pose, panel);
  let lowest = mismatch(base, best);
  for (let dy = -SEARCH; dy <= SEARCH; dy += 1) {
    for (let dx = -SEARCH; dx <= SEARCH; dx += 1) {
      const candidate = crop(pose, panel, dx, dy);
      const score = mismatch(base, candidate);
      if (score < lowest) {
        lowest = score;
        best = candidate;
      }
    }
  }
  return best;
}

function patch(
  palette: readonly Rgb[],
  base: readonly Rgb[],
  pose: readonly Rgb[]
): string {
  let encoded = "";
  pose.forEach((colour, pixel) => {
    const original = base[pixel] ?? colour;
    if (distance(colour, original) <= PATCH_THRESHOLD) {
      return;
    }
    const index = nearest(palette, colour);
    if (index !== nearest(palette, original)) {
      encoded +=
        digit(pixel % SPRITE_SIZE) +
        digit(Math.floor(pixel / SPRITE_SIZE)) +
        digit(index);
    }
  });
  return encoded;
}

function byHealth<Value>(values: readonly Value[]): Record<string, Value> {
  const keyed: Record<string, Value> = {};
  values.forEach((value, index) => {
    keyed[HEALTH[index] ?? String(index)] = value;
  });
  return keyed;
}

async function build(name: string, art: readonly string[]): Promise<string> {
  const base = await load(`${name}.png`);
  const frames = panels(name, base);
  const crops = frames.map((panel) => crop(base, panel));
  const sprites = crops.map(shrink);
  const palette = paletteOf(sprites);
  const states = sprites.map((sprite) =>
    Array.from({ length: SPRITE_SIZE }, (_, y) =>
      sprite
        .slice(y * SPRITE_SIZE, (y + 1) * SPRITE_SIZE)
        .map((colour) => digit(nearest(palette, colour)))
        .join("")
    )
  );
  const poses: Partial<Record<Pose, Record<string, string>>> = {};
  for (const pose of POSES) {
    const file = `${name}-${pose}.png`;
    if (!art.includes(file)) {
      continue;
    }
    const image = await load(file);
    const patches = frames.map((panel, index) => {
      const original = crops[index] ?? crop(base, panel);
      return patch(
        palette,
        sprites[index] ?? [],
        shrink(align(original, image, panel))
      );
    });
    poses[pose] = byHealth(patches);
    process.stdout.write(
      `${name} ${pose}: ${patches.map((encoded) => encoded.length / 3).join(" ")} pixels\n`
    );
  }
  const sheet = {
    palette: palette.map(hex),
    poses,
    states: byHealth(states),
  };
  const path = resolve(OUT, `${name}.ts`);
  await writeFile(
    path,
    [
      'import type { SpriteSheet } from "@/model/sprite";',
      "",
      `export const ${name}: SpriteSheet = ${JSON.stringify(sheet)};`,
      "",
    ].join("\n")
  );
  return path;
}

const files = await readdir(ART);
const names = files.flatMap((file) => BASE.exec(file)?.[1] ?? []);
await mkdir(OUT, { recursive: true });
const written: string[] = [];
for (const name of names) {
  written.push(await build(name, files));
}
const format = spawn(
  ["bun", "x", "--no-install", "biome", "check", "--write", ...written],
  { cwd: ROOT, stderr: "inherit", stdout: "ignore" }
);
process.exitCode = await format.exited;
