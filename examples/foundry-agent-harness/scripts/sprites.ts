import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { spawn } from "bun";
import { HEALTH, POSES, type Pose } from "../src/model/sprite";

const ROOT = resolve(import.meta.dirname, "..");
const ART = resolve(ROOT, "art");
const OUT = resolve(ROOT, "src/model/sprites");
const ASSETS = resolve(ROOT, "src/assets/avatars");
const CELL = 256;
const GRID = 32;
const COARSE_THRESHOLD = 45;
const FINE_THRESHOLD = 18;
const WHITE = 235;
const INSET = 14;
const HEADROOM = 0.45;
const BACKDROP_THRESHOLD = 40;
const FULL_BLEED = 0.995;
const TINTED = new Set(["caster", "machinist"]);
const ZOOM_OUT: Readonly<Record<string, number>> = {
  assayer: 1.3,
  automaton: 1.3,
  caster: 1.2,
  fitter: 1.4,
  machinist: 1.25,
  rigger: 1.4,
  stoker: 1.25,
  welder: 1.3,
};
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
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly side: number;
  readonly top: number;
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

function inked(
  image: Image,
  along: "column" | "row",
  index: number,
  [from, to]: readonly [number, number] = [
    0,
    along === "column" ? image.height : image.width,
  ]
): number {
  let count = 0;
  for (let step = from; step < to; step += 1) {
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

const HEADROOMS: Readonly<Record<string, number>> = {
  assayer: 0.3,
  fitter: 0.12,
  rigger: 0.3,
};

const FRAMES: Readonly<
  Record<string, { band: [number, number]; columns: [number, number][] }>
> = {
  fitter: {
    band: [42, 630],
    columns: [
      [20, 317],
      [331, 629],
      [643, 941],
      [954, 1252],
      [1265, 1562],
    ],
  },
};

function framed(
  [top, bottom]: readonly [number, number],
  columns: readonly (readonly [number, number])[],
  name: string
): Panel[] {
  const zoom = ZOOM_OUT[name] ?? 1;
  const headroom = HEADROOMS[name] ?? HEADROOM;
  return columns.map(([from, to]) => {
    const tall = bottom - top - INSET * 2;
    const fitted = Math.min(to - from, bottom - top) - INSET * 2;
    const side = Math.round(fitted * zoom);
    return {
      bottom: bottom - INSET,
      left: from + INSET,
      right: to - INSET,
      side,
      top: top + INSET,
      x: Math.floor((from + to) / 2 - side / 2),
      y: top + INSET + Math.floor((tall - side) * headroom),
    };
  });
}

function panels(name: string, image: Image): Panel[] {
  const fixed = FRAMES[name];
  if (fixed) {
    return framed(fixed.band, fixed.columns, name);
  }
  const [band] = runs(
    Array.from(
      { length: image.height },
      (_, y) => inked(image, "row", y) > image.width * ROW_FILL
    )
  ).sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
  if (band === undefined) {
    throw new Error(`${name}: found no row of panels`);
  }
  const bled = (y: number) =>
    inked(image, "row", y) >= image.width * FULL_BLEED;
  let [top, bottom] = band;
  while (top < bottom && bled(top)) {
    top += 1;
  }
  while (bottom > top && bled(bottom - 1)) {
    bottom -= 1;
  }
  if (bottom - top <= MIN_PANEL) {
    [top, bottom] = band;
  }
  const quarter = Math.floor((bottom - top) / 4);
  const wide = ([from, to]: readonly [number, number]) => to - from > MIN_PANEL;
  const whole = runs(
    Array.from(
      { length: image.width },
      (_, x) => inked(image, "column", x) > image.height * COLUMN_FILL
    )
  )
    .filter(wide)
    .slice(0, HEALTH.length);
  const middle = runs(
    Array.from(
      { length: image.width },
      (_, x) =>
        inked(image, "column", x, [top + quarter, bottom - quarter]) >
        (bottom - top) * COLUMN_FILL
    )
  ).filter(wide);
  const share = image.width / HEALTH.length;
  const fifths = HEALTH.map((_, index): [number, number] => [
    Math.round(index * share),
    Math.round((index + 1) * share),
  ]);
  const columns =
    [whole, middle].find((each) => each.length === HEALTH.length) ?? fifths;
  return framed([top, bottom], columns, name);
}

function crop(
  image: Image,
  panel: Panel,
  { dx = 0, dy = 0, tinted = false } = {}
): Image {
  const { side } = panel;
  const data = new Uint8Array(side * side * 3);
  for (let y = 0; y < side; y += 1) {
    const row = panel.y + dy + y;
    if (row < panel.top + dy || row >= panel.bottom + dy) {
      continue;
    }
    const start = panel.x + dx;
    const left = Math.max(start, panel.left + dx);
    const right = Math.min(start + side, panel.right + dx);
    const from = (row * image.width + left) * 3;
    data.set(
      image.data.subarray(from, from + (right - left) * 3),
      (y * side + left - start) * 3
    );
  }
  const seen = new Uint8Array(side * side);
  const stack: number[] = [];
  const cropped = { data, height: side, width: side };
  const backdrop = rgbAt(
    cropped,
    Math.max(0, panel.top - panel.y) * side + Math.max(0, panel.left - panel.x)
  );
  const plain = (pixel: number) =>
    isWhite(data, pixel) ||
    (tinted && distance(rgbAt(cropped, pixel), backdrop) < BACKDROP_THRESHOLD);
  for (let edge = 0; edge < side; edge += 1) {
    stack.push(
      edge,
      (side - 1) * side + edge,
      edge * side,
      edge * side + side - 1
    );
  }
  const first = Math.max(0, panel.top - panel.y);
  const last = Math.min(side, panel.bottom - panel.y) - 1;
  const near = Math.max(0, panel.left - panel.x);
  const far = Math.min(side, panel.right - panel.x) - 1;
  for (let x = near; x <= far; x += 1) {
    stack.push(first * side + x, last * side + x);
  }
  for (let y = first; y <= last; y += 1) {
    stack.push(y * side + near, y * side + far);
  }
  while (stack.length > 0) {
    const pixel = stack.pop() ?? 0;
    if (seen[pixel] === 1 || !plain(pixel)) {
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

function average(image: Image, x: number, y: number, size: number): Rgb {
  const side = image.width;
  const top = Math.floor((y * side) / size);
  const bottom = Math.max(top + 1, Math.floor(((y + 1) * side) / size));
  const left = Math.floor((x * side) / size);
  const right = Math.max(left + 1, Math.floor(((x + 1) * side) / size));
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

function align(base: Image, pose: Image, panel: Panel, tinted: boolean): Image {
  let best = crop(pose, panel, { tinted });
  let lowest = mismatch(base, best);
  for (let dy = -SEARCH; dy <= SEARCH; dy += 1) {
    for (let dx = -SEARCH; dx <= SEARCH; dx += 1) {
      const candidate = crop(pose, panel, { dx, dy, tinted });
      const score = mismatch(base, candidate);
      if (score < lowest) {
        lowest = score;
        best = candidate;
      }
    }
  }
  return best;
}

function scale(image: Image, size: number): Image {
  const data = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      data.set(average(image, x, y, size), (y * size + x) * 3);
    }
  }
  return { data, height: size, width: size };
}

function rgbAt(image: Image, pixel: number): Rgb {
  return [
    image.data[pixel * 3] ?? 0,
    image.data[pixel * 3 + 1] ?? 0,
    image.data[pixel * 3 + 2] ?? 0,
  ];
}

function changedCells(base: Image, pose: Image): Set<number> {
  const coarseBase = scale(base, GRID);
  const coarsePose = scale(pose, GRID);
  const cells = new Set<number>();
  for (let cell = 0; cell < GRID * GRID; cell += 1) {
    if (
      distance(rgbAt(coarseBase, cell), rgbAt(coarsePose, cell)) >
      COARSE_THRESHOLD
    ) {
      cells.add(cell);
    }
  }
  return cells;
}

const BROW_LINE = 18;
const MIN_CELLS = 4;
const EYES = { from: 0, to: BROW_LINE } as const;
const MOUTH = { from: BROW_LINE, to: GRID } as const;
const REGIONS: Partial<Record<Pose, { from: number; to: number }>> = {
  blink: EYES,
  left: EYES,
  right: EYES,
  smirk: MOUTH,
};

function within(pose: Pose, cells: ReadonlySet<number>): Set<number> {
  const { from, to } = REGIONS[pose] ?? { from: 0, to: GRID };
  const kept = [...cells].filter((cell) => {
    const row = Math.floor(cell / GRID);
    return row >= from && row < to;
  });
  return new Set(kept.length < MIN_CELLS ? [] : kept);
}

function nearChange(cells: ReadonlySet<number>, x: number, y: number) {
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const column = x + dx;
      const row = y + dy;
      const inside = column >= 0 && column < GRID && row >= 0 && row < GRID;
      if (inside && cells.has(row * GRID + column)) {
        return true;
      }
    }
  }
  return false;
}

function paste(
  atlas: Uint8Array,
  width: number,
  column: number,
  row: number,
  image: Image,
  keep: (pixel: number) => boolean
) {
  for (let pixel = 0; pixel < CELL * CELL; pixel += 1) {
    if (!keep(pixel)) {
      continue;
    }
    const x = column * CELL + (pixel % CELL);
    const y = row * CELL + Math.floor(pixel / CELL);
    atlas.set([...rgbAt(image, pixel), 255], (y * width + x) * 4);
  }
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

function encode(rgba: Uint8Array, width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const stride = width * 4;
  const rows = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    rows.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

async function build(name: string, art: readonly string[]): Promise<string> {
  const source = await load(`${name}.png`);
  const frames = panels(name, source);
  const tinted = TINTED.has(name);
  const crops = frames.map((panel) => crop(source, panel, { tinted }));
  const bases = crops.map((image) => scale(image, CELL));
  const poses = POSES.filter((pose) => art.includes(`${name}-${pose}.png`));
  const width = HEALTH.length * CELL;
  const atlas = new Uint8Array(width * (poses.length + 1) * CELL * 4);
  bases.forEach((base, column) => {
    paste(atlas, width, column, 0, base, () => true);
  });
  const still: Partial<Record<Pose, string[]>> = {};
  for (const [index, pose] of poses.entries()) {
    const image = await load(`${name}-${pose}.png`);
    const counts = frames.map((panel, column) => {
      const base =
        bases[column] ?? scale(crop(source, panel, { tinted }), CELL);
      const posed = scale(
        align(
          crops[column] ?? crop(source, panel, { tinted }),
          image,
          panel,
          tinted
        ),
        CELL
      );
      const cells = within(pose, changedCells(base, posed));
      paste(atlas, width, column, index + 1, posed, (pixel) => {
        const x = Math.floor(((pixel % CELL) * GRID) / CELL);
        const y = Math.floor((Math.floor(pixel / CELL) * GRID) / CELL);
        return (
          nearChange(cells, x, y) &&
          distance(rgbAt(base, pixel), rgbAt(posed, pixel)) > FINE_THRESHOLD
        );
      });
      if (cells.size === 0) {
        still[pose] = [...(still[pose] ?? []), HEALTH[column] ?? ""];
      }
      return cells.size;
    });
    process.stdout.write(`${name} ${pose}: ${counts.join(" ")} cells\n`);
  }
  await writeFile(
    resolve(ASSETS, `${name}.png`),
    encode(atlas, width, (poses.length + 1) * CELL)
  );
  const sheet = { cell: CELL, file: `${name}.png`, poses, still };
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
await mkdir(ASSETS, { recursive: true });
const written: string[] = [];
for (const name of names) {
  written.push(await build(name, files));
}
const format = spawn(
  ["bun", "x", "--no-install", "biome", "check", "--write", ...written],
  { cwd: ROOT, stderr: "inherit", stdout: "ignore" }
);
process.exitCode = await format.exited;
