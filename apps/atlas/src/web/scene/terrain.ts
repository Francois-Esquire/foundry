import {
  BufferAttribute,
  type BufferGeometry,
  type InterleavedBufferAttribute,
  Path,
  Shape,
  ShapeGeometry,
  Vector2,
  Vector3,
} from "three";
import { TessellateModifier } from "three/addons/modifiers/TessellateModifier.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import type { Polygon, Territory } from "../types";
import { paperThickness } from "./paper-material";

export function terrainHeight(p: Territory, x: number, y: number): number {
  let distance = Number.POSITIVE_INFINITY;
  for (const polygon of p.coast) {
    for (const ring of polygon) {
      for (let i = 1; i < ring.length; i += 1) {
        const a = ring[i - 1];
        const b = ring[i];
        if (!(a && b)) {
          continue;
        }
        const dx = b[0] - a[0],
          dy = b[1] - a[1];
        const t = Math.max(
          0,
          Math.min(
            1,
            ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)
          )
        );
        distance = Math.min(
          distance,
          Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy)
        );
      }
    }
  }
  const shore = Math.min(1, distance / 28);
  const taper = shore * shore * (3 - 2 * shore);
  const density = p.files.reduce(
    (sum, f) =>
      sum + Math.exp(-((x - f.x) ** 2 + (y - f.y) ** 2) / (2 * 22 ** 2)),
    0
  );
  return paperThickness + 18 * (1 - Math.exp(-density / 40)) * taper;
}

export function terrainGeometry(
  p: Territory,
  polygon: Polygon,
  width: number,
  height: number
): BufferGeometry {
  const rings = polygon.map((ring) => ring.map(([x, y]) => new Vector2(x, -y)));
  const shape = new Shape(rings[0]);
  for (const hole of rings.slice(1)) {
    shape.holes.push(new Path(hole));
  }
  const base = new ShapeGeometry(shape);
  const triangles = new TessellateModifier(5, 12).modify(base);
  base.dispose();
  triangles.deleteAttribute("normal");
  const geometry = mergeVertices(triangles);
  triangles.dispose();
  const positions = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  const normals = new Float32Array(positions.count * 3);
  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.getX(i),
      y = positions.getY(i);
    positions.setXYZ(i, p.x + x, -p.y + y, terrainHeight(p, x, -y));
    uv.setXY(i, (p.x + x) / width + 0.5, (-p.y + y) / height + 0.5);
    const dx =
      (terrainHeight(p, x + 0.2, -y) - terrainHeight(p, x - 0.2, -y)) / 0.4;
    const dy =
      (terrainHeight(p, x, -y + 0.2) - terrainHeight(p, x, -y - 0.2)) / 0.4;
    new Vector3(-dx, dy, 1).normalize().toArray(normals, i * 3);
  }
  geometry.setAttribute("normal", new BufferAttribute(normals, 3));
  geometry.setAttribute(
    "occlusion",
    new BufferAttribute(reliefOcclusion(geometry), 1)
  );
  return geometry;
}

/** Concavity per unit of edge length that counts as full occlusion. */
const occlusionGain = 4;
const occlusionSmoothing = 2;

interface Neighbourhood {
  edgeSum: Float32Array;
  heightSum: Float32Array;
  neighbours: Float32Array;
}

/** Sums each vertex's neighbouring heights and edge lengths over the index. */
function gatherNeighbours(
  positions: BufferAttribute | InterleavedBufferAttribute,
  index: BufferAttribute
): Neighbourhood {
  const { count } = positions;
  const heightSum = new Float32Array(count);
  const edgeSum = new Float32Array(count);
  const neighbours = new Float32Array(count);
  const edge = (a: number, b: number) => {
    heightSum[a] = (heightSum[a] ?? 0) + positions.getZ(b);
    edgeSum[a] =
      (edgeSum[a] ?? 0) +
      Math.hypot(
        positions.getX(a) - positions.getX(b),
        positions.getY(a) - positions.getY(b)
      );
    neighbours[a] = (neighbours[a] ?? 0) + 1;
  };
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i),
      b = index.getX(i + 1),
      c = index.getX(i + 2);
    edge(a, b);
    edge(b, a);
    edge(b, c);
    edge(c, b);
    edge(c, a);
    edge(a, c);
  }
  return { edgeSum, heightSum, neighbours };
}

/**
 * One averaging pass over neighbours, so the term shades as a wash rather
 * than a mesh-frequency speckle.
 */
function smoothOcclusion(
  occlusion: Float32Array,
  index: BufferAttribute,
  neighbours: Float32Array
) {
  const sum = new Float32Array(occlusion.length);
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i),
      b = index.getX(i + 1),
      c = index.getX(i + 2);
    sum[a] = (sum[a] ?? 0) + (occlusion[b] ?? 0) + (occlusion[c] ?? 0);
    sum[b] = (sum[b] ?? 0) + (occlusion[a] ?? 0) + (occlusion[c] ?? 0);
    sum[c] = (sum[c] ?? 0) + (occlusion[a] ?? 0) + (occlusion[b] ?? 0);
  }
  for (let i = 0; i < occlusion.length; i += 1) {
    const n = neighbours[i] ?? 0;
    if (n > 0) {
      occlusion[i] = ((occlusion[i] ?? 0) + (sum[i] ?? 0) / n) / 2;
    }
  }
}

/**
 * Concavity of the relief at each vertex: 0 on ridges and flats, rising to 1
 * in valleys and at the foot of hills. It comes from mesh neighbours rather
 * than extra height samples, so it costs nothing beyond the geometry itself.
 */
function reliefOcclusion(geometry: BufferGeometry): Float32Array {
  const positions = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const occlusion = new Float32Array(positions.count);
  if (!index) {
    return occlusion;
  }
  const { edgeSum, heightSum, neighbours } = gatherNeighbours(positions, index);
  for (let i = 0; i < positions.count; i += 1) {
    const n = neighbours[i] ?? 0;
    if (n === 0) {
      continue;
    }
    const concavity =
      ((heightSum[i] ?? 0) / n - positions.getZ(i)) / ((edgeSum[i] ?? 0) / n);
    occlusion[i] = Math.min(1, Math.max(0, concavity * occlusionGain));
  }
  for (let pass = 0; pass < occlusionSmoothing; pass += 1) {
    smoothOcclusion(occlusion, index, neighbours);
  }
  return occlusion;
}

export function settlementColor(kind: string): string {
  switch (kind) {
    case "test":
      return "#526f7b";
    case "story":
      return "#975b70";
    case "config":
      return "#896629";
    case "source":
      return "#665139";
    default:
      return "#8d8064";
  }
}
