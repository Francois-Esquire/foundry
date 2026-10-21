/**
 * Cells from every cell of a raster to the nearest land cell, by the exact
 * Euclidean distance transform: squared distances along each row, then
 * along each column, each a lower envelope of parabolas. Land cells read 0.
 * Every pass works in typed scratch arrays reused across lines, and a row's
 * squared distances are stored as 32-bit floats before the column pass
 * reads them, so the result does not depend on how the passes are stored.
 */
export function shoreDistances(
  land: Uint8Array,
  width: number,
  height: number
): Float32Array {
  const far = (width + height) ** 2;
  const distances = Float32Array.from(land, (cell) => (cell ? 0 : far));
  const length = Math.max(width, height);
  const scratch: Envelope = {
    boundaries: new Float64Array(length + 1),
    line: new Float64Array(length),
    out: new Float64Array(length),
    sites: new Int32Array(length),
  };
  for (let y = 0; y < height; y += 1) {
    const offset = y * width;
    for (let x = 0; x < width; x += 1) {
      scratch.line[x] = distances[offset + x] as number;
    }
    squaredDistances(scratch, width);
    for (let x = 0; x < width; x += 1) {
      distances[offset + x] = scratch.out[x] as number;
    }
  }
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      scratch.line[y] = distances[y * width + x] as number;
    }
    squaredDistances(scratch, height);
    for (let y = 0; y < height; y += 1) {
      distances[y * width + x] = Math.sqrt(scratch.out[y] as number);
    }
  }
  return distances;
}

/** Reused buffers for one line's lower envelope: its input, output, sites and boundaries. */
interface Envelope {
  boundaries: Float64Array;
  line: Float64Array;
  out: Float64Array;
  sites: Int32Array;
}

/**
 * The squared distance transform of the first `count` entries of
 * `scratch.line` into `scratch.out`: each entry the least of
 * `(q - site)² + line[site]` over every site.
 */
function squaredDistances(scratch: Envelope, count: number): void {
  const { boundaries, line, out, sites } = scratch;
  if (count <= 0) {
    return;
  }
  sites[0] = 0;
  boundaries[0] = Number.NEGATIVE_INFINITY;
  boundaries[1] = Number.POSITIVE_INFINITY;
  let k = 0;
  for (let q = 1; q < count; q += 1) {
    const value = line[q] as number;
    let intersection = 0;
    for (;;) {
      const site = sites[k] as number;
      intersection =
        (value + q * q - (line[site] as number) - site * site) /
        (2 * (q - site));
      if (intersection > (boundaries[k] as number)) {
        break;
      }
      k -= 1;
    }
    k += 1;
    sites[k] = q;
    boundaries[k] = intersection;
    boundaries[k + 1] = Number.POSITIVE_INFINITY;
  }
  k = 0;
  for (let q = 0; q < count; q += 1) {
    while ((boundaries[k + 1] as number) < q) {
      k += 1;
    }
    const site = sites[k] as number;
    out[q] = (q - site) ** 2 + (line[site] as number);
  }
}
