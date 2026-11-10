/**
 * Removes ruled lines from a sheet: baselines, cell borders and other guides.
 * A guide is thin and runs a long way, level or nearly so. Only its thin
 * stretches are removed, so a stroke that crosses or stands on it stays whole.
 */
import { type Bitmap, createBitmap, inkAt } from "../raster/bitmap";

export interface GuideOptions {
  /** A guide may be hidden behind glyphs for this many pixels and still be one line. */
  readonly maximumGap: number;
  /** A guide is at most this many pixels thick. */
  readonly maximumThickness: number;
  /** A guide runs for at least this many pixels. */
  readonly minimumLength: number;
  readonly threshold: number;
}

export interface GuideRemoval {
  readonly bitmap: Bitmap;
  /** How many separate lines were taken out. */
  readonly removed: number;
}

/** A thin vertical run of ink in one column. `bottom` is exclusive. */
interface ThinRun {
  readonly bottom: number;
  readonly top: number;
  readonly x: number;
}

/** Thin runs in neighbouring columns that follow one another: a line in the making. */
interface Chain {
  readonly runs: ThinRun[];
}

/** How far a line may climb or fall per column and still be followed: about three degrees. */
const DRIFT = 0.05;
/** A line shows in at least this share of the columns it spans. */
const COVERAGE = 0.4;

const transpose = (bitmap: Bitmap): Bitmap => {
  const turned = createBitmap(bitmap.height, bitmap.width);
  for (let y = 0; y < bitmap.height; y += 1) {
    for (let x = 0; x < bitmap.width; x += 1) {
      turned.data[x * turned.width + y] =
        bitmap.data[y * bitmap.width + x] ?? 0;
    }
  }
  return turned;
};

const thinRunsIn = (
  bitmap: Bitmap,
  x: number,
  options: GuideOptions
): ThinRun[] => {
  const runs: ThinRun[] = [];
  let top = -1;
  for (let y = 0; y <= bitmap.height; y += 1) {
    const isInk = inkAt(bitmap, x, y) >= options.threshold;
    if (isInk && top < 0) {
      top = y;
    } else if (!isInk && top >= 0) {
      if (y - top <= options.maximumThickness) {
        runs.push({ bottom: y, top, x });
      }
      top = -1;
    }
  }
  return runs;
};

const middle = (run: ThinRun) => (run.top + run.bottom) / 2;

const follows = (chain: Chain, run: ThinRun, options: GuideOptions) => {
  const last = chain.runs.at(-1);
  if (!last) {
    return false;
  }
  const gap = run.x - last.x;
  return (
    gap > 0 &&
    gap <= options.maximumGap &&
    Math.abs(middle(run) - middle(last)) <= 1.5 + DRIFT * gap
  );
};

const isLine = ({ runs }: Chain, options: GuideOptions) => {
  const span = (runs.at(-1)?.x ?? 0) - (runs[0]?.x ?? 0) + 1;
  return span >= options.minimumLength && runs.length >= COVERAGE * span;
};

/**
 * Where a line passes behind a glyph it cannot be seen as a thin run. Its
 * place there is read off the runs on either side.
 */
const hiddenStretches = ({ runs }: Chain): ThinRun[] => {
  const hidden: ThinRun[] = [];
  for (let index = 1; index < runs.length; index += 1) {
    const before = runs[index - 1];
    const after = runs[index];
    if (!(before && after)) {
      continue;
    }
    for (let x = before.x + 1; x < after.x; x += 1) {
      const t = (x - before.x) / (after.x - before.x);
      hidden.push({
        bottom: Math.round(before.bottom + t * (after.bottom - before.bottom)),
        top: Math.round(before.top + t * (after.top - before.top)),
        x,
      });
    }
  }
  return hidden;
};

const erase = (bitmap: Bitmap, x: number, top: number, bottom: number) => {
  for (let y = Math.max(0, top); y < Math.min(bitmap.height, bottom); y += 1) {
    bitmap.data[y * bitmap.width + x] = 0;
  }
};

/** Takes out thin lines that run along the rows, working on a copy. */
const removeLevelLines = (
  bitmap: Bitmap,
  options: GuideOptions
): GuideRemoval => {
  const chains: Chain[] = [];
  let open: Chain[] = [];
  for (let x = 0; x < bitmap.width; x += 1) {
    open = open.filter(
      (chain) => x - (chain.runs.at(-1)?.x ?? 0) <= options.maximumGap
    );
    for (const run of thinRunsIn(bitmap, x, options)) {
      const chain = open.find((candidate) => follows(candidate, run, options));
      if (chain) {
        chain.runs.push(run);
      } else {
        const started: Chain = { runs: [run] };
        open.push(started);
        chains.push(started);
      }
    }
  }
  const cleaned: Bitmap = { ...bitmap, data: bitmap.data.slice() };
  const lines = chains.filter((chain) => isLine(chain, options));
  const isInk = (x: number, y: number) =>
    inkAt(bitmap, x, y) >= options.threshold;
  for (const line of lines) {
    for (const { bottom, top, x } of line.runs) {
      // The grey fringe above and below goes with the line.
      erase(cleaned, x, top - 1, bottom + 1);
    }
    for (const { bottom, top, x } of hiddenStretches(line)) {
      // A stroke that continues on both sides crosses the line and stays
      // whole. One that stops at the line stands on it and gives the line up.
      if (!(isInk(x, top - 2) && isInk(x, bottom + 1))) {
        erase(cleaned, x, top, bottom);
      }
    }
  }
  return { bitmap: cleaned, removed: lines.length };
};

/** Takes out thin lines that run along rows or columns, even slightly turned. */
export const removeGuideLines = (
  bitmap: Bitmap,
  options: GuideOptions
): GuideRemoval => {
  const level = removeLevelLines(bitmap, options);
  const upright = removeLevelLines(transpose(level.bitmap), options);
  return {
    bitmap: transpose(upright.bitmap),
    removed: level.removed + upright.removed,
  };
};
