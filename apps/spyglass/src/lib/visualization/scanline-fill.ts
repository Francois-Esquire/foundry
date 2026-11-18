type Point = readonly [number, number];

const centreSample: readonly Point[] = [[0.5, 0.5]];

export function fillPolygon(
  mask: Uint8Array,
  width: number,
  height: number,
  rings: readonly (readonly Point[])[],
  samples: readonly Point[] = centreSample
): void {
  for (const [sampleX, sampleY] of samples) {
    const crossings = rowCrossings(rings, height, sampleY);
    for (const [row, xs] of crossings.entries()) {
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const from = Math.max(0, Math.ceil((xs[i] ?? 0) - sampleX));
        const to = Math.min(width - 1, Math.floor((xs[i + 1] ?? 0) - sampleX));
        if (from <= to) {
          mask.fill(1, row * width + from, row * width + to + 1);
        }
      }
    }
  }
}

function rowCrossings(
  rings: readonly (readonly Point[])[],
  height: number,
  sampleY: number
): number[][] {
  const crossings: number[][] = Array.from({ length: height }, () => []);
  for (const ring of rings) {
    if (ring.length < 2) {
      continue;
    }
    for (const [i, a] of ring.entries()) {
      crossEdge(crossings, a, ring[(i + 1) % ring.length] ?? a, sampleY);
    }
  }
  return crossings;
}

function crossEdge(
  crossings: number[][],
  a: Point,
  b: Point,
  sampleY: number
): void {
  if (a[1] === b[1]) {
    return;
  }
  const [low, high] = a[1] < b[1] ? [a, b] : [b, a];
  const slope = (high[0] - low[0]) / (high[1] - low[1]);
  const first = Math.max(0, Math.ceil(low[1] - sampleY));
  const last = Math.min(crossings.length - 1, Math.ceil(high[1] - sampleY) - 1);
  for (let row = first; row <= last; row += 1) {
    crossings[row]?.push(low[0] + (row + sampleY - low[1]) * slope);
  }
}
