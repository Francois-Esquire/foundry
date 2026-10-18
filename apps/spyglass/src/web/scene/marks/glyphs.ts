import {
  type BufferGeometry,
  CircleGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  RingGeometry,
} from "three";
import { attribute, positionGeometry, uniform, vec3 } from "three/tsl";
import { MeshBasicNodeMaterial } from "three/webgpu";
import {
  alphaAt,
  type Glyph,
  type GlyphShape,
  type MarkAlpha,
} from "../../layout/marks";
import { drapedHeight, flatMarkHeight } from "./drape";
import { inkColour } from "./strokes";

interface GlyphKey {
  alpha: MarkAlpha;
  draped: boolean;
  shape: GlyphShape;
}

export interface GlyphBatch {
  glyphs: Glyph[];
  key: GlyphKey;
}

/** Glyphs grouped by shape, alpha and plane; centre, size and ink are per instance. */
export function batchGlyphs(glyphs: readonly Glyph[]): GlyphBatch[] {
  const batches: GlyphBatch[] = [];
  for (const glyph of glyphs) {
    const draped = glyph.on !== undefined;
    let batch = batches.find(
      ({ key }) =>
        key.shape === glyph.shape &&
        key.alpha === glyph.alpha &&
        key.draped === draped
    );
    if (!batch) {
      batch = {
        glyphs: [],
        key: { alpha: glyph.alpha, draped, shape: glyph.shape },
      };
      batches.push(batch);
    }
    batch.glyphs.push(glyph);
  }
  return batches;
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
    case "diamond":
      return new CircleGeometry(0.5, 4);
    case "tick":
      return new PlaneGeometry(0.14, 1);
    default:
      return new CircleGeometry(0.5, 24);
  }
}

/**
 * One batch as an instanced mesh: the shape's vertices are scaled by each
 * glyph's size in chart units at the zoom, set as one uniform each frame,
 * and moved to its centre, so glyphs keep their screen size at every zoom.
 */
export function createGlyphBatch(batch: GlyphBatch, renderOrder: number) {
  const { key } = batch;
  const count = batch.glyphs.length;
  const shape = glyphShapeGeometry(key.shape);
  const geometry = new InstancedBufferGeometry();
  geometry.setIndex(shape.getIndex());
  geometry.setAttribute("position", shape.getAttribute("position"));
  geometry.instanceCount = count;
  const centres = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
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
    const { r, g, b } = inkColour(glyph.colour);
    colours.set([r, g, b], i * 3);
  }
  geometry.setAttribute(
    "glyphCentre",
    new InstancedBufferAttribute(centres, 3)
  );
  geometry.setAttribute("glyphSize", new InstancedBufferAttribute(sizes, 1));
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
  material.positionNode = vec3(
    positionGeometry.xy.mul(attribute("glyphSize", "float")).mul(unitsPerPixel),
    0
  ).add(attribute("glyphCentre", "vec3"));
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
