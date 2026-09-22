type Tone = "empty" | "highlight" | "base" | "fill" | "shadow";

const TONES: Readonly<Record<string, Tone>> = {
  " ": "empty",
  b: "base",
  f: "fill",
  h: "highlight",
  s: "shadow",
};

// Match the approved artwork: a thin bright rim around a quiet center.
const DIAMOND = [
  "    h    ",
  "    h    ",
  "   hbh   ",
  "  hbffh  ",
  " hbfffsh ",
  "hhbfffshh",
  " hffffsh ",
  "  hffsh  ",
  "   hsh   ",
  "    h    ",
  "    h    ",
];
const STAR = [" h ", "hhh", " h "];
const CROSS = ["  b  ", "  b  ", "bbhbb", "  b  ", "  b  "];
const DOT = ["h"];

// Composition follows the reference, with breathing room and no enclosing pattern.
const PLACEMENT = [
  { green: false, rows: DIAMOND, x: 0.065, y: 0.22 },
  { green: true, rows: DIAMOND, x: 0.925, y: 0.415 },
  { green: false, rows: DIAMOND, x: 0.915, y: 0.795 },
  { green: false, rows: CROSS, x: 0.91, y: 0.125 },
  { green: false, rows: CROSS, x: 0.125, y: 0.665 },
  { green: false, rows: STAR, x: 0.835, y: 0.54 },
  { green: false, rows: CROSS, x: 0.175, y: 0.3 },
  { green: false, rows: STAR, x: 0.28, y: 0.095 },
  { green: true, rows: STAR, x: 0.585, y: 0.095 },
  { green: true, rows: STAR, x: 0.86, y: 0.27 },
  { green: true, rows: STAR, x: 0.057, y: 0.785 },
  { green: true, rows: STAR, x: 0.08, y: 0.485 },
  { green: false, rows: CROSS, x: 0.285, y: 0.9 },
  { green: true, rows: STAR, x: 0.675, y: 0.9 },
  { green: false, rows: DOT, x: 0.34, y: 0.035 },
  { green: false, rows: DOT, x: 0.155, y: 0.11 },
  { green: false, rows: DOT, x: 0.96, y: 0.2 },
  { green: false, rows: DOT, x: 0.1, y: 0.39 },
  { green: false, rows: DOT, x: 0.165, y: 0.55 },
  { green: true, rows: DOT, x: 0.835, y: 0.725 },
  { green: false, rows: DOT, x: 0.13, y: 0.91 },
  { green: false, rows: DOT, x: 0.835, y: 0.88 },
  { green: false, rows: DOT, x: 0.735, y: 0.125 },
  { green: false, rows: STAR, x: 0.805, y: 0.35 },
  { green: false, rows: DOT, x: 0.9, y: 0.605 },
  { green: false, rows: DOT, x: 0.17, y: 0.815 },
];

function sprite(rows: readonly string[]) {
  const width = rows[0]?.length ?? 0;
  const height = Math.ceil(rows.length / 2);
  const toneAt = (x: number, y: number) =>
    TONES[rows[y]?.[x] ?? " "] ?? "empty";
  const pixels = Array.from({ length: height * width }, (_, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    const upper = toneAt(x, y * 2);
    const lower = toneAt(x, y * 2 + 1);
    let text = " ";
    let foreground = upper;
    let background: Tone = "empty";
    if (upper !== "empty") {
      text = "▀";
      background = lower;
    } else if (lower !== "empty") {
      text = "▄";
      foreground = lower;
    }
    if (x === width - 1 && y < height - 1) {
      text += "\n";
    }
    return { background, foreground, id: `${x}:${y}`, text };
  });
  return { height, pixels, width };
}

/** Keep the composition fixed; use math only for independent light cycles. */
export function createSparkles() {
  return PLACEMENT.map(({ rows, ...placement }, index) => {
    const point = rows === DOT;
    const phase = ((index + 1) * ((1 + Math.sqrt(5)) / 2)) % 1;
    return {
      ...placement,
      brightness: point ? 0.35 + phase * 0.3 : 0.72,
      compact: sprite(rows === DIAMOND ? CROSS : rows),
      glint: point ? 0.12 : 0.23,
      id: `sparkle:${index}`,
      offset: phase,
      period: 5 + phase * 3,
      shape: sprite(rows),
    };
  });
}
