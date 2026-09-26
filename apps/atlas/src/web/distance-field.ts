export function shoreDistances(
  land: Uint8Array,
  width: number,
  height: number
): Float32Array {
  const distances = Float32Array.from(land, (cell) =>
    cell ? 0 : (width + height) ** 2
  );
  for (let y = 0; y < height; y++) {
    distances.set(
      squaredDistances(Array.from(distances.slice(y * width, (y + 1) * width))),
      y * width
    );
  }
  for (let x = 0; x < width; x++) {
    const column = squaredDistances(
      Array.from({ length: height }, (_, y) => distances[y * width + x] ?? 0)
    );
    column.forEach((distance, y) => {
      distances[y * width + x] = Math.sqrt(distance);
    });
  }
  return distances;
}

function squaredDistances(values: number[]): number[] {
  const sites = [0];
  const boundaries = [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
  let k = 0;
  for (let q = 1; q < values.length; q++) {
    let intersection: number;
    while (true) {
      const site = sites[k] ?? 0;
      intersection =
        ((values[q] ?? 0) + q * q - (values[site] ?? 0) - site * site) /
        (2 * (q - site));
      if (intersection > (boundaries[k] ?? Number.NEGATIVE_INFINITY)) {
        break;
      }
      k--;
    }
    sites[++k] = q;
    boundaries[k] = intersection;
    boundaries[k + 1] = Number.POSITIVE_INFINITY;
  }
  k = 0;
  return values.map((_, q) => {
    while ((boundaries[k + 1] ?? Number.POSITIVE_INFINITY) < q) {
      k++;
    }
    const site = sites[k] ?? 0;
    return (q - site) ** 2 + (values[site] ?? 0);
  });
}
