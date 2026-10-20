import { floor, int, ivec2, max, textureLoad, vec2, vec4 } from "three/tsl";
import type { Node, Texture } from "three/webgpu";
import type { GeologyGrid } from "../../lib/visualization/geology";
import {
  type KernelTerraceSettings,
  kernelTerrace,
} from "../../lib/visualization/terrain-kernel-terrace";
import type { StepSample } from "./contour-lines";
import { nodeMath } from "./terrain-kernel-tsl";

/**
 * The screen terrain's seabed between the world grid's cells: the grid's
 * fields read as a cubic B-spline with its slope, the terrace pass's steps
 * cut per sample from the seabed before the pass, and the step coordinate
 * the plates and bathymetric contours are drawn from, all from the seabed's
 * own smooth field, so no edge follows the grid's cells at any zoom.
 */

/** The cubic B-spline's four weights for a fraction. */
function bSplineWeights(t: Node<"float">): Node<"float">[] {
  const s = t.oneMinus();
  const t2 = t.mul(t);
  const t3 = t2.mul(t);
  return [
    s.mul(s).mul(s).div(6),
    t3.mul(3).sub(t2.mul(6)).add(4).div(6),
    t3.mul(-3).add(t2.mul(3)).add(t.mul(3)).add(1).div(6),
    t3.div(6),
  ];
}

/** The cubic B-spline's weights' slopes for a fraction. */
function bSplineSlopes(t: Node<"float">): Node<"float">[] {
  const s = t.oneMinus();
  const t2 = t.mul(t);
  return [
    s.mul(s).mul(-0.5),
    t2.mul(1.5).sub(t.mul(2)),
    t2.mul(-1.5).add(t).add(0.5),
    t2.mul(0.5),
  ];
}

/** A grid field's four channels at a point and their slopes per map unit, x right and y down the chart. */
export interface SplineSample {
  slopeX: Node<"vec4">;
  slopeY: Node<"vec4">;
  value: Node<"vec4">;
}

/**
 * A four-channel grid texture at a map position, a cubic B-spline over the
 * cells round it, with its slopes: smooth to its curvature and never past
 * the values it reads.
 */
export function splineSample(
  texture: Texture,
  grid: GeologyGrid,
  x: Node<"float">,
  y: Node<"float">
): SplineSample {
  const u = x.sub(grid.left).div(grid.cell).sub(0.5);
  const v = y.sub(grid.top).div(grid.cell).sub(0.5);
  const column = floor(u);
  const row = floor(v);
  const fx = u.sub(column);
  const fy = v.sub(row);
  const wx = bSplineWeights(fx);
  const wy = bSplineWeights(fy);
  const dx = bSplineSlopes(fx);
  const dy = bSplineSlopes(fy);
  let value: Node<"vec4"> = vec4(0);
  let slopeX: Node<"vec4"> = vec4(0);
  let slopeY: Node<"vec4"> = vec4(0);
  for (let j = 0; j < 4; j += 1) {
    for (let i = 0; i < 4; i += 1) {
      const c = int(column.add(i - 1).clamp(0, grid.width - 1));
      const r = int(row.add(j - 1).clamp(0, grid.height - 1));
      const texel = textureLoad(texture, ivec2(c, r));
      const across = wx[i] as Node<"float">;
      const down = wy[j] as Node<"float">;
      value = value.add(texel.mul(across).mul(down));
      slopeX = slopeX.add(texel.mul(dx[i] as Node<"float">).mul(down));
      slopeY = slopeY.add(texel.mul(across).mul(dy[j] as Node<"float">));
    }
  }
  return {
    slopeX: slopeX.div(grid.cell),
    slopeY: slopeY.div(grid.cell),
    value,
  };
}

/** The terrace pass's steps cut into the seabed before it, at its slope there. */
export function terraceNode(
  height: Node<"float">,
  slope: Node<"vec2">,
  terrace: KernelTerraceSettings
): Node<"float"> {
  return kernelTerrace(nodeMath, height, slope.length(), terrace);
}

/**
 * The plates' step sample from the traced step field (`contourStepField`)
 * read between its cells: the coordinate, an integer on each level line;
 * the unit direction down it, world x right and y up; and the span's width
 * across the slope. `slope` is the coordinate's, per map unit, x right and
 * y down the chart.
 */
export function stepsNode(
  coordinate: Node<"float">,
  slope: Node<"vec2">,
  spacing: Node<"float">
): StepSample {
  const run = slope.length();
  return {
    coordinate,
    // The chart's y runs down; the world's up.
    downhill: vec2(slope.x, slope.y.negate()).negate().div(max(run, 1e-9)),
    spacing,
  };
}
