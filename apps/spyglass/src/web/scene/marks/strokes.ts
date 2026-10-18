import {
  AddEquation,
  Color,
  CustomBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  SrcAlphaFactor,
} from "three";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineSegments2 } from "three/addons/lines/webgpu/LineSegments2.js";
import { materialOpacity, uniform, uv } from "three/tsl";
import { Line2NodeMaterial, type NodeBuilder } from "three/webgpu";
import type { Territory } from "../../data/types";
import {
  alphaAt,
  type MarkAlpha,
  type Stroke,
  type StrokeDash,
} from "../../layout/marks";
import { polylineVertices } from "./drape";

/** What one stroke batch shares: everything but the colour, which is per vertex. */
export interface StrokeKey {
  alpha: MarkAlpha;
  cap: NonNullable<Stroke["cap"]>;
  dash: Stroke["dash"];
  draped: boolean;
  width: number;
}

export interface StrokeBatch {
  key: StrokeKey;
  strokes: Stroke[];
}

const alphaIds = new Map<MarkAlpha, number>();

/** A stable id for an alpha, so two strokes sharing a function share a batch. */
function alphaId(alpha: MarkAlpha): string {
  if (typeof alpha === "number") {
    return `=${alpha}`;
  }
  let id = alphaIds.get(alpha);
  if (id === undefined) {
    id = alphaIds.size;
    alphaIds.set(alpha, id);
  }
  return `fn${id}`;
}

function keyOf(stroke: Stroke): StrokeKey {
  return {
    alpha: stroke.alpha,
    cap: stroke.cap ?? "round",
    dash: stroke.dash,
    draped: stroke.on !== undefined,
    width: stroke.width,
  };
}

/** The batch key as text: strokes with the same text draw as one object. */
export function strokeKeyText(key: StrokeKey): string {
  return [
    key.width,
    key.dash ? key.dash.join("/") : "solid",
    key.cap,
    key.draped ? "draped" : "flat",
    alphaId(key.alpha),
  ].join("|");
}

/**
 * Strokes grouped into the objects that draw them, in the order the first
 * stroke of each group appeared, so a layer's marks still draw bottom to
 * top. Colour is a vertex attribute, so one batch carries many inks.
 */
export function batchStrokes(strokes: readonly Stroke[]): StrokeBatch[] {
  const batches = new Map<string, StrokeBatch>();
  for (const stroke of strokes) {
    const key = keyOf(stroke);
    const text = strokeKeyText(key);
    let batch = batches.get(text);
    if (!batch) {
      batch = { key, strokes: [] };
      batches.set(text, batch);
    }
    batch.strokes.push(stroke);
  }
  return [...batches.values()];
}

const inkColours = new Map<string, Color>();

/** A ladder ink as a linear colour; the renderer encodes it back to sRGB. */
export function inkColour(ink: string): Color {
  let colour = inkColours.get(ink);
  if (!colour) {
    colour = new Color(ink);
    inkColours.set(ink, colour);
  }
  return colour;
}

/**
 * The line material with hardware blending. `Line2NodeMaterial` blends a
 * transparent line itself, against a copy of the opaque frame, which misses
 * the chart's transparent planes and then blends again on output; it only
 * does so while `transparent` is set during setup, so setup sees it unset.
 */
class StrokeMaterial extends Line2NodeMaterial {
  override setupDiffuseColor(builder: NodeBuilder): void {
    const { transparent } = this;
    this.transparent = false;
    try {
      super.setupDiffuseColor(builder);
    } finally {
      this.transparent = transparent;
    }
  }
}

/** Segment endpoints and their colours, for the whole batch. */
function segmentArrays(
  strokes: readonly Stroke[],
  territories: readonly Territory[]
) {
  const positions: number[] = [];
  const colours: number[] = [];
  for (const stroke of strokes) {
    const vertices = polylineVertices(stroke.points, stroke.on, territories);
    const { r, g, b } = inkColour(stroke.colour);
    for (let v = 3; v + 2 < vertices.length; v += 3) {
      positions.push(
        vertices[v - 3] ?? 0,
        vertices[v - 2] ?? 0,
        vertices[v - 1] ?? 0,
        vertices[v] ?? 0,
        vertices[v + 1] ?? 0,
        vertices[v + 2] ?? 0
      );
      colours.push(r, g, b, r, g, b);
    }
  }
  return { colours, positions, segments: positions.length / 6 };
}

/** A dash longer than any line, so an undashed stroke's dash path never breaks it. */
const endlessDash = 1e9;

/**
 * The ribbon is drawn one device pixel wider than the stroke and its alpha
 * ramps to nothing over that pixel on each side: the coverage an
 * antialiased stroke would have, since the scene pass has no multisampling
 * and a hairline narrower than a pixel would otherwise drop out.
 */
const feather = 1;

/**
 * One pass over a batch's geometry: the line object and its material, with
 * the ribbon's half width as a uniform the opacity ramp reads.
 */
function linePass(
  geometry: LineSegmentsGeometry,
  key: StrokeKey,
  renderOrder: number
) {
  /** Half the drawn ribbon in device pixels: the stroke's half width plus the feather. */
  const halfRibbon = uniform(1);
  const material = new StrokeMaterial({
    alphaToCoverage: false,
    blendDst: OneMinusSrcAlphaFactor,
    blendDstAlpha: OneMinusSrcAlphaFactor,
    blendEquation: AddEquation,
    blending: CustomBlending,
    blendSrc: SrcAlphaFactor,
    blendSrcAlpha: OneFactor,
    dashed: true,
    depthTest: !key.draped,
    depthWrite: false,
    transparent: true,
    vertexColors: true,
    worldUnits: false,
  });
  // Across the ribbon, uv.x runs −1..1; the ramp is one pixel of it.
  material.opacityNode = materialOpacity.mul(
    halfRibbon.mul(uv().x.abs().oneMinus()).clamp(0, 1)
  );
  const object = new LineSegments2(geometry, material);
  object.computeLineDistances();
  object.renderOrder = renderOrder;
  object.frustumCulled = false;
  return { halfRibbon, material, object };
}

/**
 * A dash as the material draws it, in CSS pixels: the pattern's entry at
 * `index`, drawn at least the stroke's width long, as a round-capped canvas
 * dot was the width round, and the gap that keeps the pattern's period; the
 * pattern is shifted so the dash starts where the entry does.
 */
function dashSpan(
  pattern: StrokeDash,
  index: number,
  width: number
): { dash: number; gap: number; offset: number } {
  const period = pattern.reduce((sum, length) => sum + length, 0);
  const entry = pattern[index] ?? 0;
  const follows = pattern[index + 1] ?? 0;
  const dash = Math.min(Math.max(entry, width), entry + follows);
  let start = 0;
  for (let i = 0; i < index; i += 1) {
    start += pattern[i] ?? 0;
  }
  return { dash, gap: period - dash, offset: period - start };
}

/**
 * One batch as a screen-space line object. Widths and dashes are CSS
 * pixels: `setView` rescales them to the device each frame, and evaluates
 * the batch's alpha at the zoom. Draped strokes follow the relief by their
 * vertices and draw in order over it rather than against its depth, since a
 * screen-width ribbon on a rising shore would otherwise sink into the land;
 * a stroke draped on the chart reads the islands to find what lies under
 * each vertex.
 *
 * Every stroke ends and joins square. The line material rounds each
 * segment's ends on its own, and where segments meet a translucent stroke
 * then blends twice, beading at every joint; its dash path discards those
 * ends, so every batch takes it, with no gap unless the stroke has a dash.
 * The material knows one dash and one gap, so a dash-dot stroke is drawn
 * twice over the same geometry: the dashes, and the dots offset to fall in
 * the gaps between them.
 */
export function createStrokeBatch(
  batch: StrokeBatch,
  renderOrder: number,
  territories: readonly Territory[] = []
) {
  const { key } = batch;
  const geometry = new LineSegmentsGeometry();
  const { colours, positions, segments } = segmentArrays(
    batch.strokes,
    territories
  );
  geometry.setPositions(positions);
  geometry.setColors(colours);
  const dashes = linePass(geometry, key, renderOrder);
  const dots =
    key.dash && key.dash.length === 4
      ? linePass(geometry, key, renderOrder)
      : undefined;
  if (dots) {
    dashes.object.add(dots.object);
  }
  const passes = dots ? [dashes, dots] : [dashes];
  return {
    dispose() {
      geometry.dispose();
      for (const pass of passes) {
        pass.material.dispose();
      }
    },
    object: dashes.object,
    segments,
    setView(pixelsPerUnit: number, pixelRatio: number) {
      for (const [i, { halfRibbon, material }] of passes.entries()) {
        halfRibbon.value = (key.width * pixelRatio + feather) / 2;
        material.linewidth = halfRibbon.value * 2;
        material.opacity = alphaAt(key.alpha, pixelsPerUnit);
        material.scale = pixelsPerUnit * pixelRatio;
        if (!key.dash) {
          material.dashSize = endlessDash;
          material.gapSize = 0;
          continue;
        }
        // The material reads its offset as a uniform only if it compiled
        // with one set; a span's offset is never zero, so both passes do.
        const span = dashSpan(key.dash, i * 2, key.width);
        material.dashSize = span.dash * pixelRatio;
        material.gapSize = span.gap * pixelRatio;
        material.dashOffset = span.offset * pixelRatio;
      }
    },
  };
}
