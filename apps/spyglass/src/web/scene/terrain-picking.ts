import { type BufferGeometry, Vector3 } from "three";
import { paperThickness } from "./paper-material";

// Fixed-camera projection makes a small 2D bin sufficient for exact mesh hits.
const cellSize = 8;

function indexGeometry(geometry: BufferGeometry, tilt: number) {
  const positions = geometry.getAttribute("position");
  const indices = geometry.getIndex();
  const vertex = (index: number) => indices?.getX(index) ?? index;
  const projected = new Float64Array(positions.count * 2);
  const bins = new Map<string, number[]>();
  const slope = Math.tan(tilt);
  for (let index = 0; index < positions.count; index += 1) {
    projected[index * 2] = positions.getX(index);
    projected[index * 2 + 1] =
      positions.getY(index) + (positions.getZ(index) - paperThickness) * slope;
  }
  const point = (index: number) => {
    const id = vertex(index);
    return {
      x: projected[id * 2] ?? 0,
      y: projected[id * 2 + 1] ?? 0,
      z: positions.getZ(id),
    };
  };
  for (let index = 0; index < (indices?.count ?? positions.count); index += 3) {
    const a = point(index),
      b = point(index + 1),
      c = point(index + 2);
    const left = Math.floor(Math.min(a.x, b.x, c.x) / cellSize);
    const right = Math.floor(Math.max(a.x, b.x, c.x) / cellSize);
    const top = Math.floor(Math.min(a.y, b.y, c.y) / cellSize);
    const bottom = Math.floor(Math.max(a.y, b.y, c.y) / cellSize);
    for (let row = top; row <= bottom; row += 1) {
      for (let col = left; col <= right; col += 1) {
        const key = `${col}:${row}`;
        const bin = bins.get(key) ?? [];
        bin.push(index);
        bins.set(key, bin);
      }
    }
  }
  return { bins, point };
}

interface ProjectedPoint {
  x: number;
  y: number;
  z: number;
}

function triangleHeight(
  point: Vector3,
  a: ProjectedPoint,
  b: ProjectedPoint,
  c: ProjectedPoint
) {
  const determinant = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  // Front faces only, matching Three's terrain material, including steep slopes.
  if (determinant <= 0) {
    return;
  }
  const u =
    ((b.y - c.y) * (point.x - c.x) + (c.x - b.x) * (point.y - c.y)) /
    determinant;
  const v =
    ((c.y - a.y) * (point.x - c.x) + (a.x - c.x) * (point.y - c.y)) /
    determinant;
  if (u < -1e-8 || v < -1e-8 || u + v > 1 + 1e-8) {
    return;
  }
  return u * a.z + v * b.z + (1 - u - v) * c.z;
}

/** Rebuild after reshaping; return the nearest visible triangle on the same ray. */
export function createTerrainPicker(
  geometries: BufferGeometry[],
  tilt: number
) {
  const entries = geometries.map((geometry) => indexGeometry(geometry, tilt));
  return (point: Vector3): Vector3 | undefined => {
    const key = `${Math.floor(point.x / cellSize)}:${Math.floor(point.y / cellSize)}`;
    let height = Number.NEGATIVE_INFINITY;
    for (const entry of entries) {
      for (const index of entry.bins.get(key) ?? []) {
        const elevation = triangleHeight(
          point,
          entry.point(index),
          entry.point(index + 1),
          entry.point(index + 2)
        );
        if (elevation !== undefined) {
          height = Math.max(height, elevation);
        }
      }
    }
    return Number.isFinite(height)
      ? new Vector3(
          point.x,
          point.y - (height - paperThickness) * Math.tan(tilt),
          height
        )
      : undefined;
  };
}
