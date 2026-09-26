export function waveArrivalField(
  distances: Float32Array,
  width: number,
  height: number,
  scale: number,
  bearing: number
) {
  const dx = Math.sin((bearing * Math.PI) / 180),
    dy = -Math.cos((bearing * Math.PI) / 180);
  // Match heap precision: rounded-up arrivals can endlessly requeue equal routes.
  const arrival = new Float64Array(distances.length).fill(
    Number.POSITIVE_INFINITY
  );
  const exposure = new Float32Array(distances.length);
  const heap: { i: number; time: number }[] = [];
  const push = (i: number, time: number) => {
    let n = heap.length;
    heap.push({ i, time });
    while (n > 0) {
      const parent = (n - 1) >> 1;
      const previous = heap[parent];
      if (!previous || previous.time <= time) {
        break;
      }
      heap[n] = previous;
      n = parent;
    }
    heap[n] = { i, time };
  };
  const pop = () => {
    const first = heap[0],
      last = heap.pop();
    if (heap.length && last) {
      let n = 0;
      while (n * 2 + 1 < heap.length) {
        let child = n * 2 + 1;
        if (
          (heap[child + 1]?.time ?? Number.POSITIVE_INFINITY) <
          (heap[child]?.time ?? Number.POSITIVE_INFINITY)
        ) {
          child++;
        }
        const next = heap[child];
        if (!next || next.time >= last.time) {
          break;
        }
        heap[n] = next;
        n = child;
      }
      heap[n] = last;
    }
    return first;
  };
  const minimum = Math.min(0, dx * width) + Math.min(0, dy * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!(distances[i] ?? 0)) {
        continue;
      }
      if (
        (x === 0 && dx > 0.001) ||
        (x === width - 1 && dx < -0.001) ||
        (y === 0 && dy > 0.001) ||
        (y === height - 1 && dy < -0.001)
      ) {
        arrival[i] = (dx * x + dy * y - minimum) / scale / 28;
        push(i, arrival[i] ?? 0);
      }
      exposure[i] = 1;
      for (let step = 1; step <= 16; step++) {
        const xx = Math.round(x - dx * step * 3),
          yy = Math.round(y - dy * step * 3);
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) {
          break;
        }
        if (!(distances[yy * width + xx] ?? 0)) {
          exposure[i] = 0.18;
          break;
        }
      }
    }
  }
  const steps = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ] as const;
  while (heap.length) {
    const cell = pop();
    if (
      !cell ||
      cell.time > (arrival[cell.i] ?? Number.POSITIVE_INFINITY) + 0.0001
    ) {
      continue;
    }
    const x = cell.i % width,
      y = Math.floor(cell.i / width);
    for (const [sx, sy] of steps) {
      const xx = x + sx,
        yy = y + sy;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) {
        continue;
      }
      const i = yy * width + xx;
      if (!(distances[i] ?? 0)) {
        continue;
      }
      if (
        sx &&
        sy &&
        !((distances[y * width + xx] ?? 0) && (distances[yy * width + x] ?? 0))
      ) {
        continue;
      }
      const length = Math.hypot(sx, sy);
      const speed =
        8 + Math.min(20, Math.sqrt((distances[i] ?? 0) / scale) * 2);
      const time =
        cell.time +
        (length / scale / speed) *
          (1 + Math.max(0, -(sx * dx + sy * dy) / length) * 3);
      if (time >= (arrival[i] ?? Number.POSITIVE_INFINITY)) {
        continue;
      }
      arrival[i] = time;
      push(i, time);
    }
  }
  return { arrival, exposure };
}
