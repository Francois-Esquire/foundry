/** A small, stationary bevel on a stack of thin shelves, lit from the chart's northwest. */
export function foundationRelief(
  field: { width: number; height: number; values: Float32Array },
  extent: { width: number; height: number }
): Float32Array {
  const { width, height, values } = field;
  if (
    !(
      extent.width > 0 &&
      extent.height > 0 &&
      Number.isFinite(extent.width) &&
      Number.isFinite(extent.height)
    )
  ) {
    return new Float32Array(values.length);
  }
  const heights = Float32Array.from({ length: width * height }, (_, i) =>
    terraceHeight(values[i * 2] ?? 0)
  );
  const softened = bevel(
    bevel(heights, width, height, false),
    width,
    height,
    true
  );
  const relief = new Float32Array(values.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const dx =
        (((softened[y * width + Math.min(width - 1, x + 1)] ?? 0) -
          (softened[y * width + Math.max(0, x - 1)] ?? 0)) *
          width) /
        extent.width;
      const dy =
        (((softened[Math.min(height - 1, y + 1) * width + x] ?? 0) -
          (softened[Math.max(0, y - 1) * width + x] ?? 0)) *
          height) /
        extent.height;
      relief[index * 2] = softened[index] ?? 0;
      relief[index * 2 + 1] = Math.max(-1, Math.min(1, (dx + dy) * 24));
    }
  }
  return relief;
}

function bevel(
  values: Float32Array,
  width: number,
  height: number,
  vertical: boolean
): Float32Array {
  const result = new Float32Array(values.length);
  const kernel = [1, 2, 1];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -1; k <= 1; k += 1) {
        const column = Math.max(0, Math.min(width - 1, x + (vertical ? 0 : k)));
        const row = Math.max(0, Math.min(height - 1, y + (vertical ? k : 0)));
        sum += ((values[row * width + column] ?? 0) * (kernel[k + 1] ?? 0)) / 4;
      }
      result[y * width + x] = sum;
    }
  }
  return result;
}

/** Saturating overlap has a stable scale across focus changes and dataset sizes. */
function terraceHeight(overlap: number): number {
  const positive = Math.max(0, overlap);
  const level = (positive / (positive + 6)) * 12;
  const base = Math.floor(level);
  const t = Math.max(0, Math.min(1, (level - base - 0.3) / 0.4));
  return (base + t * t * (3 - 2 * t)) / 12;
}
