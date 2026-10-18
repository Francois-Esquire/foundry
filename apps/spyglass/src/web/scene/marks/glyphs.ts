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
import {
  alphaAt,
  type Glyph,
  type GlyphShape,
  type MarkAlpha,
} from "../../layout/marks";
import { tiltStretch } from "../../view/chart-view";
import { drapedHeight, flatMarkHeight } from "./drape";
import { inkColour } from "./strokes";

interface GlyphKey {
  alpha: MarkAlpha;
  draped: boolean;
  shape: GlyphShape;
  upright: boolean;
}

export interface GlyphBatch {
  glyphs: Glyph[];
  key: GlyphKey;
}

/** Glyphs grouped by shape, alpha, plane and stance; centre, size, offset, weight and ink are per instance. */
export function batchGlyphs(glyphs: readonly Glyph[]): GlyphBatch[] {
  const batches: GlyphBatch[] = [];
  for (const glyph of glyphs) {
    const draped = glyph.on !== undefined;
    const upright = glyph.upright === true;
    let batch = batches.find(
      ({ key }) =>
        key.shape === glyph.shape &&
        key.alpha === glyph.alpha &&
        key.draped === draped &&
        key.upright === upright
    );
    if (!batch) {
      batch = {
        glyphs: [],
        key: { alpha: glyph.alpha, draped, shape: glyph.shape, upright },
      };
      batches.push(batch);
    }
    batch.glyphs.push(glyph);
  }
  return batches;
}

/**
 * A hollow unit square: its outer corners stay put and its inner ones are
 * drawn in by the glyph's weight through the `inset` attribute, so the band
 * is the weight in pixels at any size.
 */
function frameGeometry(): BufferGeometry {
  const corners = [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ] as const;
  const positions: number[] = [];
  const insets: number[] = [];
  for (const [x, y] of corners) {
    positions.push(x, y, 0);
    insets.push(0, 0);
  }
  for (const [x, y] of corners) {
    positions.push(x, y, 0);
    insets.push(-Math.sign(x), -Math.sign(y));
  }
  const index: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const next = (i + 1) % 4;
    index.push(i, next, 4 + next, i, 4 + next, 4 + i);
  }
  const geometry = new BufferGeometry();
  geometry.setIndex(index);
  geometry.setAttribute(
    "position",
    new BufferAttribute(Float32Array.from(positions), 3)
  );
  geometry.setAttribute(
    "inset",
    new BufferAttribute(Float32Array.from(insets), 2)
  );
  return geometry;
}

/** The shape at unit diameter, centred on the origin; a ring's band is a fixed share of its radius. */
function glyphShapeGeometry(shape: GlyphShape): BufferGeometry {
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
 * glyph's size in chart units at the zoom, set as one uniform each frame,
 * drawn in by its weight, stretched north–south when the batch stands
 * upright, and moved to its centre and offset, so glyphs keep their screen
 * size at every zoom.
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
    sizes[i] = glyph.size;
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
      material.opacity = alphaAt(key.alpha, pixelsPerUnit);
    },
    vertices: shape.getAttribute("position").count * count,
  };
}
