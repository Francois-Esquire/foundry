/** The original folder-anchored, import-pulled file geography, shared by scan and viewer. */
interface PlacementFile {
  directory: string;
  id: string;
  x: number;
  y: number;
}

export function fileFootprint(size: number): number {
  return 28 + 5.8 * Math.sqrt(size);
}

function placementUnit(id: string): number {
  let h = 2_166_136_261;
  for (const c of id) {
    // biome-ignore lint/suspicious/noBitwiseOperators: Preserve the deterministic 32-bit hash used for map placement and colors.
    h = Math.imul(h ^ c.charCodeAt(0), 16_777_619);
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: Preserve the deterministic 32-bit hash used for map placement and colors.
  return (h >>> 0) / 4_294_967_296;
}

export function placeFiles(
  files: PlacementFile[],
  radius: number,
  edges: { source: string; target: string }[]
): void {
  const byId = new Map(files.map((f) => [f.id, f]));
  const links = edges.flatMap((e) => {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    return a && b ? [[a, b] as const] : [];
  });
  const anchors = files.map((f) => {
    const angle = placementUnit(f.directory) * Math.PI * 2;
    const distance =
      Math.sqrt(placementUnit(`${f.directory}:distance`)) * radius * 0.62;
    return { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance };
  });
  for (const [i, f] of files.entries()) {
    const a = anchors[i];
    if (!a) {
      continue;
    }
    const angle = placementUnit(f.id) * Math.PI * 2;
    const distance =
      Math.sqrt(placementUnit(`${f.id}:distance`)) * radius * 0.24;
    f.x = a.x + Math.cos(angle) * distance;
    f.y = a.y + Math.sin(angle) * distance;
  }
  for (let step = 0; step < 100; step += 1) {
    for (const [a, b] of links) {
      const dx = (b.x - a.x) * 0.012;
      const dy = (b.y - a.y) * 0.012;
      a.x += dx;
      a.y += dy;
      b.x -= dx;
      b.y -= dy;
    }
    const grid = new Map<string, PlacementFile[]>();
    for (const [i, f] of files.entries()) {
      const a = anchors[i];
      if (!a) {
        continue;
      }
      f.x += (a.x - f.x) * 0.025;
      f.y += (a.y - f.y) * 0.025;
      const gx = Math.floor(f.x / 6);
      const gy = Math.floor(f.y / 6);
      separateFiles(gx, gy, grid, f);
      const key = `${gx},${gy}`;
      const bucket = grid.get(key) ?? [];
      bucket.push(f);
      grid.set(key, bucket);
    }
  }
}

function separateFiles(
  gx: number,
  gy: number,
  grid: Map<string, PlacementFile[]>,
  f: PlacementFile
) {
  for (let x = gx - 1; x <= gx + 1; x += 1) {
    for (let y = gy - 1; y <= gy + 1; y += 1) {
      for (const other of grid.get(`${x},${y}`) ?? []) {
        const dx = f.x - other.x || 0.01;
        const dy = f.y - other.y || 0.01;
        const d = Math.hypot(dx, dy);
        if (d >= 5) {
          continue;
        }
        const push = ((5 - d) / d) * 0.5;
        f.x += dx * push;
        f.y += dy * push;
        other.x -= dx * push;
        other.y -= dy * push;
      }
    }
  }
}
