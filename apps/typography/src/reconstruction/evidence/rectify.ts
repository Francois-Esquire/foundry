/**
 * Rectification: the pixels of a region, upright. A rectangle is cut out. A
 * quadrilateral is warped to a rectangle by the projective map that takes the
 * rectangle's corners to the four given points, which undoes the perspective
 * of a flat surface seen at an angle. Depth is not flat and is not undone.
 */
import type { RasterImage } from "~/generation/raster/bitmap";
import type { Point, Transform } from "~/typeface/outline";
import { type Corners, cornersOf, type EvidenceRegion } from "./region";

export interface RegionView {
  /** The region's pixels, upright, four bytes each. */
  readonly image: RasterImage;
  readonly region: EvidenceRegion;
  /** View pixels per evidence pixel along the region's edges. */
  readonly scale: number;
  /** Where a point of the view lies on the evidence, in evidence pixels. */
  toEvidence(point: Point): Point;
  /**
   * The same map as one affine transform. Only a rectangle has one: a
   * quadrilateral maps back by a projective map, which `toEvidence` applies.
   */
  readonly viewToEvidence?: Transform;
}

export interface ViewOptions {
  /**
   * How many view pixels are made from one evidence pixel. Above 1 the
   * region is enlarged with smooth interpolation, which keeps letters that
   * stand a few pixels apart from running together.
   */
  readonly scale?: number;
}

/** The coefficients of x = (a·u + b·v + c) / (g·u + h·v + 1), and y likewise with d, e, f. */
interface Projection {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
  readonly g: number;
  readonly h: number;
}

/** The projective map from the unit square to four corners (Heckbert's closed form). */
const projectionOnto = ([p0, p1, p2, p3]: Corners): Projection => {
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  const denominator = dx1 * dy2 - dy1 * dx2;
  const g = denominator === 0 ? 0 : (sx * dy2 - dx2 * sy) / denominator;
  const h = denominator === 0 ? 0 : (dx1 * sy - sx * dy1) / denominator;
  return {
    a: p1.x - p0.x + g * p1.x,
    b: p3.x - p0.x + h * p3.x,
    c: p0.x,
    d: p1.y - p0.y + g * p1.y,
    e: p3.y - p0.y + h * p3.y,
    f: p0.y,
    g,
    h,
  };
};

const project = (map: Projection, u: number, v: number): Point => {
  const w = map.g * u + map.h * v + 1;
  return {
    x: (map.a * u + map.b * v + map.c) / w,
    y: (map.d * u + map.e * v + map.f) / w,
  };
};

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

const CHANNELS = 4;

/** Reads the picture between pixel centres, weighting the four nearest pixels. */
const sampleInto = (
  source: RasterImage,
  { x, y }: Point,
  into: Uint8Array,
  at: number
) => {
  const fx = Math.min(source.width - 1, Math.max(0, x - 0.5));
  const fy = Math.min(source.height - 1, Math.max(0, y - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(source.width - 1, x0 + 1);
  const y1 = Math.min(source.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  for (let channel = 0; channel < CHANNELS; channel += 1) {
    const read = (px: number, py: number) =>
      source.data[(py * source.width + px) * CHANNELS + channel] ?? 0;
    const top = read(x0, y0) * (1 - tx) + read(x1, y0) * tx;
    const bottom = read(x0, y1) * (1 - tx) + read(x1, y1) * tx;
    into[at + channel] = Math.round(top * (1 - ty) + bottom * ty);
  }
};

/** The upright view of a region of a picture. */
export const viewRegion = (
  picture: RasterImage,
  region: EvidenceRegion,
  options: ViewOptions = {}
): RegionView => {
  const scale = options.scale ?? 1;
  const corners = cornersOf(region);
  const [p0, p1, p2, p3] = corners;
  const width = Math.max(
    1,
    Math.round((scale * (distance(p0, p1) + distance(p3, p2))) / 2)
  );
  const height = Math.max(
    1,
    Math.round((scale * (distance(p0, p3) + distance(p1, p2))) / 2)
  );
  const map = projectionOnto(corners);
  const toEvidence = ({ x, y }: Point) => project(map, x / width, y / height);
  const data = new Uint8Array(width * height * CHANNELS);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      sampleInto(
        picture,
        toEvidence({ x: x + 0.5, y: y + 0.5 }),
        data,
        (y * width + x) * CHANNELS
      );
    }
  }
  return {
    image: { data, height, width },
    region,
    scale,
    toEvidence,
    viewToEvidence:
      region.kind === "rectangle"
        ? {
            dx: region.x,
            dy: region.y,
            xx: region.width / width,
            xy: 0,
            yx: 0,
            yy: region.height / height,
          }
        : undefined,
  };
};
