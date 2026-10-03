import type { TerrainField } from "./terrain-field";

export interface TerrainSurface {
  mineral: Float32Array;
  normals: Float32Array;
  occlusion: Float32Array;
  positions: Float32Array;
}

/** Pure vertex sampling, shared by initial construction and the relief worker. */
export function sampleTerrainSurface(
  positions: Float32Array,
  origin: { x: number; y: number },
  field: TerrainField,
  thickness: number
): TerrainSurface {
  const count = positions.length / 3;
  const normals = new Float32Array(positions.length);
  const occlusion = new Float32Array(count);
  const mineral = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    const x = (positions[offset] ?? 0) - origin.x;
    const y = -(positions[offset + 1] ?? 0) - origin.y;
    const sample = field.sample(x, y);
    positions[offset + 2] = thickness + sample.elevation;
    const east = field.sample(x + 0.5, y).elevation;
    const west = field.sample(x - 0.5, y).elevation;
    const south = field.sample(x, y + 0.5).elevation;
    const north = field.sample(x, y - 0.5).elevation;
    occlusion[index] = Math.max(
      0,
      Math.min(1, ((east + west + south + north) / 4 - sample.elevation) * 4)
    );
    const dx = west - east;
    const dy = south - north;
    const length = Math.sqrt(dx * dx + dy * dy + 1);
    normals[offset] = dx / length;
    normals[offset + 1] = dy / length;
    normals[offset + 2] = 1 / length;
    mineral[index] = sample.mineral;
  }
  return { mineral, normals, occlusion, positions };
}
