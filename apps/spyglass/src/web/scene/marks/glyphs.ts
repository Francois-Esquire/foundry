import {
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  RingGeometry,
} from "three";
import { attribute, positionGeometry, uniform, vec2, vec3 } from "three/tsl";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { closeMark } from "../../ladder/ink-ladder";
import {
  alphaAt,
  type Glyph,
  type GlyphShape,
  type MarkAlpha,
  type MarkSize,
  sizeAt,
} from "../../layout/marks";
import { tiltStretch } from "../../view/chart-view";
import { drapedHeight, flatMarkHeight } from "./drape";
import { inkColour } from "./strokes";

interface GlyphKey {
  alpha: MarkAlpha;
  draped: boolean;
  shape: GlyphShape;
  /** The size function the batch's glyphs share; none when each glyph names its size. */
  size: Exclude<MarkSize, number> | undefined;
  upright: boolean;
}

export interface GlyphBatch {
  glyphs: Glyph[];
  key: GlyphKey;
}

/**
 * Glyphs grouped by shape, alpha, plane, stance and, for sizes that follow
 * the zoom, the size function's identity; centre, offset, weight, ink and a
 * fixed size are per instance.
 */
export function batchGlyphs(glyphs: readonly Glyph[]): GlyphBatch[] {
  const batches: GlyphBatch[] = [];
  for (const glyph of glyphs) {
    const draped = glyph.on !== undefined;
    const upright = glyph.upright === true;
    const size = typeof glyph.size === "function" ? glyph.size : undefined;
    let batch = batches.find(
      ({ key }) =>
        key.shape === glyph.shape &&
        key.alpha === glyph.alpha &&
        key.draped === draped &&
        key.upright === upright &&
        key.size === size
    );
    if (!batch) {
      batch = {
        glyphs: [],
        key: { alpha: glyph.alpha, draped, shape: glyph.shape, size, upright },
      };
      batches.push(batch);
    }
    batch.glyphs.push(glyph);
  }
  return batches;
}

/** Vertices and their insets, gathered into one geometry. */
class ShapeBuilder {
  private readonly index: number[] = [];
  private readonly insets: number[] = [];
  private readonly positions: number[] = [];

  /** A vertex at (x, y), drawn out by `inset` times the glyph's weight in pixels; its index. */
  vertex(x: number, y: number, insetX = 0, insetY = 0): number {
    this.positions.push(x, y, 0);
    this.insets.push(insetX, insetY);
    return this.positions.length / 3 - 1;
  }

  triangle(a: number, b: number, c: number): void {
    this.index.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.triangle(a, b, c);
    this.triangle(a, c, d);
  }

  /**
   * A band astride the open or closed path through `points`, as a stroked
   * path lies: each point is doubled, drawn out half the weight along its
   * `normal` on one side and in on the other.
   */
  band(
    points: readonly (readonly [number, number])[],
    normals: readonly (readonly [number, number])[],
    closed: boolean
  ): void {
    const outer: number[] = [];
    const inner: number[] = [];
    for (const [i, [x, y]] of points.entries()) {
      const [nx, ny] = normals[i] ?? [0, 0];
      outer.push(this.vertex(x, y, nx / 2, ny / 2));
      inner.push(this.vertex(x, y, -nx / 2, -ny / 2));
    }
    const last = closed ? points.length : points.length - 1;
    for (let i = 0; i < last; i += 1) {
      const next = (i + 1) % points.length;
      this.quad(
        outer[i] ?? 0,
        outer[next] ?? 0,
        inner[next] ?? 0,
        inner[i] ?? 0
      );
    }
  }

  /** A solid rectangle. */
  rect(x0: number, y0: number, x1: number, y1: number): void {
    this.quad(
      this.vertex(x0, y0),
      this.vertex(x1, y0),
      this.vertex(x1, y1),
      this.vertex(x0, y1)
    );
  }

  /** A hollow rectangle whose band straddles its edge. */
  hollowRect(x0: number, y0: number, x1: number, y1: number): void {
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const corners: [number, number][] = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
    this.band(
      corners,
      corners.map(([x, y]) => [Math.sign(x - cx), Math.sign(y - cy)]),
      true
    );
  }

  /** An arc of a circle, its band straddling the circle, from `from` to `to` radians anticlockwise from east. */
  arc(
    cx: number,
    cy: number,
    radius: number,
    from: number,
    to: number,
    segments: number
  ): void {
    const points: [number, number][] = [];
    const normals: [number, number][] = [];
    const closed = Math.abs(to - from - Math.PI * 2) < 1e-9;
    const steps = closed ? segments : segments + 1;
    for (let i = 0; i < steps; i += 1) {
      const angle = from + ((to - from) * i) / segments;
      const nx = Math.cos(angle);
      const ny = Math.sin(angle);
      points.push([cx + radius * nx, cy + radius * ny]);
      normals.push([nx, ny]);
    }
    this.band(points, normals, closed);
  }

  build(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setIndex(this.index);
    geometry.setAttribute(
      "position",
      new BufferAttribute(Float32Array.from(this.positions), 3)
    );
    geometry.setAttribute(
      "inset",
      new BufferAttribute(Float32Array.from(this.insets), 2)
    );
    return geometry;
  }
}

/**
 * A hollow unit square: its outer corners stay put and its inner ones are
 * drawn in by the glyph's weight through the `inset` attribute, so the band
 * is the weight in pixels at any size.
 */
function frameGeometry(): BufferGeometry {
  const shape = new ShapeBuilder();
  const corners = [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ] as const;
  const outer = corners.map(([x, y]) => shape.vertex(x, y));
  const inner = corners.map(([x, y]) =>
    shape.vertex(x, y, -Math.sign(x), -Math.sign(y))
  );
  for (let i = 0; i < 4; i += 1) {
    const next = (i + 1) % 4;
    shape.quad(
      outer[i] ?? 0,
      outer[next] ?? 0,
      inner[next] ?? 0,
      inner[i] ?? 0
    );
  }
  return shape.build();
}

/** A plus spanning the unit, each arm the glyph's weight wide: a fan of twelve, so the centre blends once. */
function crossGeometry(): BufferGeometry {
  const shape = new ShapeBuilder();
  const centre = shape.vertex(0, 0);
  const rim: number[] = [];
  // Round the plus anticlockwise from the east arm's southern corner.
  for (const [ax, ay] of [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ] as const) {
    // The arm's tip corners sit at the arm's end, drawn out across it; the
    // inner corner between this arm and the next sits at the centre.
    const [px, py] = [-ay, ax];
    rim.push(
      shape.vertex(ax / 2, ay / 2, -px / 2, -py / 2),
      shape.vertex(ax / 2, ay / 2, px / 2, py / 2),
      shape.vertex(0, 0, (ax + px) / 2, (ay + py) / 2)
    );
  }
  for (let i = 0; i < rim.length; i += 1) {
    shape.triangle(centre, rim[i] ?? 0, rim[(i + 1) % rim.length] ?? 0);
  }
  return shape.build();
}

/** The "( )" of the close mark: two arcs of the unit's radius, set apart by the ladder's share of it, each facing out. */
function closeMarkGeometry(): BufferGeometry {
  const shape = new ShapeBuilder();
  const apart = closeMark.apart / closeMark.radius / 2;
  for (const side of [-1, 1]) {
    const facing = side < 0 ? Math.PI : 0;
    shape.arc(
      side * apart,
      0,
      0.5,
      facing - closeMark.sweep,
      facing + closeMark.sweep,
      12
    );
  }
  return shape.build();
}

/** A bar from the centre toward the north-east, the glyph's weight wide. */
function notchGeometry(): BufferGeometry {
  const shape = new ShapeBuilder();
  const across = Math.SQRT1_2;
  shape.band(
    [
      [0.25, 0.25],
      [0.75, 0.75],
    ],
    [
      [-across, across],
      [-across, across],
    ],
    false
  );
  return shape.build();
}

/** The shape at unit diameter, centred on the origin, north up; a ring's band is a fixed share of its radius. */
function glyphShapeGeometry(shape: GlyphShape): BufferGeometry {
  const builder = new ShapeBuilder();
  switch (shape) {
    case "dot":
      return new CircleGeometry(0.5, 24);
    case "ring":
      return new RingGeometry(0.36, 0.5, 32);
    case "notchedRing":
      return new RingGeometry(0.36, 0.5, 32, 1, Math.PI * 0.65, Math.PI * 1.7);
    case "spring":
      return new RingGeometry(0.36, 0.5, 32, 1, Math.PI * 0.2, Math.PI * 1.6);
    case "diamond":
      return new CircleGeometry(0.5, 4);
    case "square":
      return new PlaneGeometry(1, 1);
    case "frame":
      return frameGeometry();
    case "tick":
      return new PlaneGeometry(0.14, 1);
    case "hoop":
      builder.arc(0, 0, 0.5, 0, Math.PI * 2, 32);
      return builder.build();
    case "halfDisc":
      return new CircleGeometry(0.5, 16, Math.PI, Math.PI);
    case "cross":
      return crossGeometry();
    case "notch":
      return notchGeometry();
    case "closeMark":
      return closeMarkGeometry();
    case "file":
      // One wide and one and a half tall, hanging south of the point.
      builder.rect(-0.5, -1, 0.5, 0.5);
      return builder.build();
    case "testFile":
      builder.hollowRect(-0.5, -1, 0.5, 0.5);
      builder.rect(-0.25, -0.5, 0.25, 0);
      return builder.build();
    case "mixed":
      builder.rect(-0.5, -0.25, -0.175, 0.25);
      builder.hollowRect(0.175, -0.25, 0.5, 0.25);
      return builder.build();
    default:
      return new CircleGeometry(0.5, 24);
  }
}

/** The shape with an `inset` attribute, zero where the shape has no band to draw in. */
function shapeWithInset(shape: GlyphShape): BufferGeometry {
  const geometry = glyphShapeGeometry(shape);
  if (!geometry.hasAttribute("inset")) {
    const { count } = geometry.getAttribute("position");
    geometry.setAttribute(
      "inset",
      new BufferAttribute(new Float32Array(count * 2), 2)
    );
  }
  return geometry;
}

/**
 * One batch as an instanced mesh: the shape's vertices are scaled by each
 * glyph's size, or the batch's size at the zoom when it follows it, in chart
 * units at the zoom, set as uniforms each frame, drawn out by its weight,
 * stretched north–south when the batch stands upright, and moved to its
 * centre and offset, so glyphs keep their screen size at every zoom.
 */
export function createGlyphBatch(batch: GlyphBatch, renderOrder: number) {
  const { key } = batch;
  const count = batch.glyphs.length;
  const shape = shapeWithInset(key.shape);
  const geometry = new InstancedBufferGeometry();
  geometry.setIndex(shape.getIndex());
  geometry.setAttribute("position", shape.getAttribute("position"));
  geometry.setAttribute("inset", shape.getAttribute("inset"));
  geometry.instanceCount = count;
  const centres = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const weights = new Float32Array(count);
  const offsets = new Float32Array(count * 2);
  const colours = new Float32Array(count * 3);
  for (const [i, glyph] of batch.glyphs.entries()) {
    centres.set(
      [
        glyph.x,
        -glyph.y,
        glyph.on ? drapedHeight(glyph.on, glyph.x, glyph.y) : flatMarkHeight,
      ],
      i * 3
    );
    sizes[i] = typeof glyph.size === "number" ? glyph.size : 1;
    weights[i] = glyph.weight ?? 0;
    offsets.set(glyph.offset ?? [0, 0], i * 2);
    const { r, g, b } = inkColour(glyph.colour);
    colours.set([r, g, b], i * 3);
  }
  geometry.setAttribute(
    "glyphCentre",
    new InstancedBufferAttribute(centres, 3)
  );
  geometry.setAttribute("glyphSize", new InstancedBufferAttribute(sizes, 1));
  geometry.setAttribute(
    "glyphWeight",
    new InstancedBufferAttribute(weights, 1)
  );
  geometry.setAttribute(
    "glyphOffset",
    new InstancedBufferAttribute(offsets, 2)
  );
  geometry.setAttribute(
    "glyphColour",
    new InstancedBufferAttribute(colours, 3)
  );
  const unitsPerPixel = uniform(1);
  /** The batch's size at the zoom when it follows it; one when each glyph names its own. */
  const sizeScale = uniform(1);
  const material = new MeshBasicNodeMaterial({
    depthTest: !key.draped,
    depthWrite: false,
    transparent: true,
  });
  // The chart's y runs south; the world's runs north.
  const stance = vec2(1, key.upright ? tiltStretch : 1);
  const band = vec2(1, 1)
    .mul(attribute("inset", "vec2"))
    .mul(attribute("glyphWeight", "float"));
  const offset = vec2(1, -1).mul(attribute("glyphOffset", "vec2"));
  const shapePixels = positionGeometry.xy
    .mul(attribute("glyphSize", "float"))
    .mul(sizeScale)
    .add(band)
    .mul(stance)
    .add(offset);
  material.positionNode = vec3(shapePixels.mul(unitsPerPixel), 0).add(
    attribute("glyphCentre", "vec3")
  );
  material.colorNode = attribute("glyphColour", "vec3");
  const object = new Mesh(geometry, material);
  object.renderOrder = renderOrder;
  object.frustumCulled = false;
  return {
    dispose() {
      geometry.dispose();
      shape.dispose();
      material.dispose();
    },
    object,
    setView(pixelsPerUnit: number) {
      unitsPerPixel.value = 1 / pixelsPerUnit;
      sizeScale.value = key.size ? sizeAt(key.size, pixelsPerUnit) : 1;
      material.opacity = alphaAt(key.alpha, pixelsPerUnit);
    },
    vertices: shape.getAttribute("position").count * count,
  };
}
