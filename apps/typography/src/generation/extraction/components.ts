/**
 * Connected pieces of ink, each with its box, its area and how thick its
 * strokes are. Thickness tells a glyph from the small text of a label.
 */
import { type Bitmap, type PixelBox, unionBox } from "../raster/bitmap";

export interface InkComponent {
  readonly area: number;
  readonly box: PixelBox;
  /** 1-based, matching the values in `Labelled.labels`. */
  readonly id: number;
  /** The widest stroke of the piece, in pixels. */
  readonly thickness: number;
}

export interface Labelled {
  readonly components: readonly InkComponent[];
  readonly height: number;
  /** For each pixel, the id of the piece it belongs to, or 0 for paper. */
  readonly labels: Int32Array;
  readonly width: number;
}

const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/**
 * Chamfer distance from each ink pixel to the nearest paper, in thirds of a
 * pixel: 3 for a straight step and 4 for a diagonal one.
 */
const distanceToPaper = (
  isInk: Uint8Array,
  width: number,
  height: number
): Int32Array => {
  const distance = new Int32Array(width * height);
  const at = (x: number, y: number) =>
    x < 0 || y < 0 || x >= width || y >= height
      ? 0
      : (distance[y * width + x] ?? 0);
  const sweep = (
    xs: readonly number[],
    ys: readonly number[],
    sign: number
  ) => {
    for (const y of ys) {
      for (const x of xs) {
        if (isInk[y * width + x]) {
          distance[y * width + x] = Math.min(
            distance[y * width + x] ?? 0,
            at(x + sign, y) + 3,
            at(x, y + sign) + 3,
            at(x + sign, y + sign) + 4,
            at(x - sign, y + sign) + 4
          );
        }
      }
    }
  };
  for (let index = 0; index < distance.length; index += 1) {
    distance[index] = isInk[index] ? 3 * (width + height) : 0;
  }
  const columns = Array.from({ length: width }, (_, x) => x);
  const rows = Array.from({ length: height }, (_, y) => y);
  sweep(columns, rows, -1);
  sweep(columns.toReversed(), rows.toReversed(), 1);
  return distance;
};

interface Growing {
  area: number;
  box: PixelBox;
  reach: number;
}

/** Labels every 8-connected piece of ink at or above the threshold. */
export const labelComponents = (
  bitmap: Bitmap,
  threshold: number
): Labelled => {
  const { height, width } = bitmap;
  const isInk = Uint8Array.from(bitmap.data, (value) =>
    value >= threshold ? 1 : 0
  );
  const distance = distanceToPaper(isInk, width, height);
  const labels = new Int32Array(width * height);
  const components: InkComponent[] = [];
  const stack: number[] = [];
  for (let seed = 0; seed < isInk.length; seed += 1) {
    if (!isInk[seed] || labels[seed]) {
      continue;
    }
    const id = components.length + 1;
    const x0 = seed % width;
    const y0 = Math.floor(seed / width);
    const piece: Growing = {
      area: 0,
      box: { bottom: y0 + 1, left: x0, right: x0 + 1, top: y0 },
      reach: 0,
    };
    labels[seed] = id;
    stack.push(seed);
    for (let index = stack.pop(); index !== undefined; index = stack.pop()) {
      const x = index % width;
      const y = Math.floor(index / width);
      piece.area += 1;
      piece.reach = Math.max(piece.reach, distance[index] ?? 0);
      piece.box = unionBox(piece.box, {
        bottom: y + 1,
        left: x,
        right: x + 1,
        top: y,
      });
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx;
        const ny = y + dy;
        const next = ny * width + nx;
        if (
          nx >= 0 &&
          ny >= 0 &&
          nx < width &&
          ny < height &&
          isInk[next] &&
          !labels[next]
        ) {
          labels[next] = id;
          stack.push(next);
        }
      }
    }
    components.push({
      area: piece.area,
      box: piece.box,
      id,
      thickness: Math.max(1, (2 * piece.reach) / 3 - 0.5),
    });
  }
  return { components, height, labels, width };
};
