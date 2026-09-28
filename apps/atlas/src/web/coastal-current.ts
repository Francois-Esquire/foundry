export function coastalCurrent(
  vx: Float32Array,
  vy: Float32Array,
  land: Uint8Array,
  width: number,
  height: number
) {
  const horizontal = new Float32Array((width + 1) * height);
  const vertical = new Float32Array(width * (height + 1));
  coastalCurrentY4(height, width, land, horizontal, vx);
  for (let y = 0; y <= height; y += 1) {
    for (let x = 0; x < width; x += 1) {
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
  coastalCurrentY(
    height,
    width,
    divergence,
    horizontal,
    vertical,
    neighbors,
    land
  );
  coastalCurrentIteration(height, width, land, neighbors, pressure, divergence);
  coastalCurrentY2(height, width, land, horizontal, pressure);
  coastalCurrentY3(height, width, land, vertical, pressure);
  const x = new Float32Array(vx.length),
    y = new Float32Array(vy.length);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
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

function coastalCurrentY4(
  height: number,
  width: number,
  land: Uint8Array<ArrayBufferLike>,
  horizontal: Float32Array<ArrayBuffer>,
  vx: Float32Array<ArrayBufferLike>
) {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x <= width; x += 1) {
      const left = y * width + Math.max(0, x - 1);
      const right = y * width + Math.min(width - 1, x);
      if (!(land[left] || land[right])) {
        horizontal[y * (width + 1) + x] =
          ((vx[left] ?? 0) + (vx[right] ?? 0)) / 2;
      }
    }
  }
}

function coastalCurrentY3(
  height: number,
  width: number,
  land: Uint8Array<ArrayBufferLike>,
  vertical: Float32Array<ArrayBuffer>,
  pressure: Float32Array<ArrayBuffer>
) {
  for (let y = 0; y <= height; y += 1) {
    for (let x = 0; x < width; x += 1) {
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
}

function coastalCurrentY2(
  height: number,
  width: number,
  land: Uint8Array<ArrayBufferLike>,
  horizontal: Float32Array<ArrayBuffer>,
  pressure: Float32Array<ArrayBuffer>
) {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x <= width; x += 1) {
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
}

function coastalCurrentY(
  height: number,
  width: number,
  divergence: Float32Array<ArrayBuffer>,
  horizontal: Float32Array<ArrayBuffer>,
  vertical: Float32Array<ArrayBuffer>,
  neighbors: Int32Array<ArrayBuffer>,
  land: Uint8Array<ArrayBufferLike>
) {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
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
}

function coastalCurrentIteration(
  height: number,
  width: number,
  land: Uint8Array<ArrayBufferLike>,
  neighbors: Int32Array<ArrayBuffer>,
  pressure: Float32Array<ArrayBuffer>,
  divergence: Float32Array<ArrayBuffer>
) {
  for (let iteration = 0; iteration < 600; iteration += 1) {
    let change = 0;
    change = coastalCurrentIterationParity(
      height,
      width,
      land,
      neighbors,
      pressure,
      divergence,
      change
    );
    if (change < 0.000_01) {
      break;
    }
  }
}

function coastalCurrentIterationParity(
  height: number,
  width: number,
  land: Uint8Array<ArrayBufferLike>,
  neighbors: Int32Array<ArrayBuffer>,
  pressure: Float32Array<ArrayBuffer>,
  divergence: Float32Array<ArrayBuffer>,
  initialChange: number
) {
  let change = initialChange;
  for (let parity = 0; parity < 2; parity += 1) {
    change = coastalCurrentIterationParityY(
      height,
      parity,
      width,
      land,
      neighbors,
      pressure,
      divergence,
      change
    );
  }
  return change;
}

function coastalCurrentIterationParityY(
  height: number,
  parity: number,
  width: number,
  land: Uint8Array<ArrayBufferLike>,
  neighbors: Int32Array<ArrayBuffer>,
  pressure: Float32Array<ArrayBuffer>,
  divergence: Float32Array<ArrayBuffer>,
  initialChange: number
) {
  let change = initialChange;
  for (let y = 0; y < height; y += 1) {
    change = coastalCurrentIterationParityYX(
      y,
      parity,
      width,
      land,
      neighbors,
      pressure,
      divergence,
      change
    );
  }
  return change;
}

function coastalCurrentIterationParityYX(
  y: number,
  parity: number,
  width: number,
  land: Uint8Array<ArrayBufferLike>,
  neighbors: Int32Array<ArrayBuffer>,
  pressure: Float32Array<ArrayBuffer>,
  divergence: Float32Array<ArrayBuffer>,
  initialChange: number
) {
  let change = initialChange;
  for (let x = (y + parity) % 2; x < width; x += 2) {
    const i = y * width + x;
    if (land[i]) {
      continue;
    }
    let sum = 0,
      count = 0;
    for (let side = 0; side < 4; side += 1) {
      const neighbor = neighbors[i * 4 + side] ?? -2;
      if (neighbor === -2) {
        continue;
      }
      count += 1;
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
  return change;
}
