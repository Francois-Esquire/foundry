export function coastalCurrent(
  vx: Float32Array,
  vy: Float32Array,
  land: Uint8Array,
  width: number,
  height: number
) {
  const horizontal = new Float32Array((width + 1) * height);
  const vertical = new Float32Array(width * (height + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x <= width; x++) {
      const left = y * width + Math.max(0, x - 1);
      const right = y * width + Math.min(width - 1, x);
      if (!(land[left] || land[right])) {
        horizontal[y * (width + 1) + x] =
          ((vx[left] ?? 0) + (vx[right] ?? 0)) / 2;
      }
    }
  }
  for (let y = 0; y <= height; y++) {
    for (let x = 0; x < width; x++) {
      const above = Math.max(0, y - 1) * width + x;
      const below = Math.min(height - 1, y) * width + x;
      if (!(land[above] || land[below])) {
        vertical[y * width + x] = ((vy[above] ?? 0) + (vy[below] ?? 0)) / 2;
      }
    }
  }
  const pressure = new Float32Array(vx.length);
  const divergence = new Float32Array(vx.length);
  const neighbors = new Int32Array(vx.length * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      divergence[i] =
        (horizontal[y * (width + 1) + x + 1] ?? 0) -
        (horizontal[y * (width + 1) + x] ?? 0) +
        (vertical[(y + 1) * width + x] ?? 0) -
        (vertical[y * width + x] ?? 0);
      [
        x > 0 ? i - 1 : -1,
        x < width - 1 ? i + 1 : -1,
        y > 0 ? i - width : -1,
        y < height - 1 ? i + width : -1,
      ].forEach((neighbor, side) => {
        neighbors[i * 4 + side] =
          neighbor >= 0 && land[neighbor] ? -2 : neighbor;
      });
    }
  }
  for (let iteration = 0; iteration < 600; iteration++) {
    let change = 0;
    for (let parity = 0; parity < 2; parity++) {
      for (let y = 0; y < height; y++) {
        for (let x = (y + parity) % 2; x < width; x += 2) {
          const i = y * width + x;
          if (land[i]) {
            continue;
          }
          let sum = 0,
            count = 0;
          for (let side = 0; side < 4; side++) {
            const neighbor = neighbors[i * 4 + side] ?? -2;
            if (neighbor === -2) {
              continue;
            }
            count++;
            if (neighbor >= 0) {
              sum += pressure[neighbor] ?? 0;
            }
          }
          if (!count) {
            continue;
          }
          const previous = pressure[i] ?? 0;
          const delta = ((sum - (divergence[i] ?? 0)) / count - previous) * 1.8;
          pressure[i] = previous + delta;
          change = Math.max(change, Math.abs(delta));
        }
      }
    }
    if (change < 0.000_01) {
      break;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x <= width; x++) {
      const left = x > 0 ? y * width + x - 1 : -1;
      const right = x < width ? y * width + x : -1;
      if ((left >= 0 && land[left]) || (right >= 0 && land[right])) {
        continue;
      }
      const i = y * (width + 1) + x;
      horizontal[i] =
        (horizontal[i] ?? 0) - ((pressure[right] ?? 0) - (pressure[left] ?? 0));
    }
  }
  for (let y = 0; y <= height; y++) {
    for (let x = 0; x < width; x++) {
      const above = y > 0 ? (y - 1) * width + x : -1;
      const below = y < height ? y * width + x : -1;
      if ((above >= 0 && land[above]) || (below >= 0 && land[below])) {
        continue;
      }
      const i = y * width + x;
      vertical[i] =
        (vertical[i] ?? 0) - ((pressure[below] ?? 0) - (pressure[above] ?? 0));
    }
  }
  const x = new Float32Array(vx.length),
    y = new Float32Array(vy.length);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const i = row * width + column;
      if (land[i]) {
        continue;
      }
      x[i] =
        ((horizontal[row * (width + 1) + column] ?? 0) +
          (horizontal[row * (width + 1) + column + 1] ?? 0)) /
        2;
      y[i] = ((vertical[i] ?? 0) + (vertical[i + width] ?? 0)) / 2;
    }
  }
  return { x, y };
}
