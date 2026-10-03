import {
  color,
  float,
  fwidth,
  min,
  mix,
  mx_noise_float,
  positionWorld,
  smoothstep,
  vec2,
} from "three/tsl";
import type { Node } from "three/webgpu";
import { chartGrid } from "../codex/bindings";

/** Stationary fibers and uneven stock, shared by land and sea in chart space. */
export function paperSurface(pigment: Node<"vec3">) {
  const point = positionWorld.xy;
  const broad = mx_noise_float(point.mul(0.045)).mul(0.008);
  const fibers = mx_noise_float(point.mul(vec2(3.8, 0.38))).mul(0.009);
  const resolved = float(1).sub(smoothstep(0.3, 1.2, fwidth(point.x)));
  return pigment.mul(float(1).add(broad).add(fibers.mul(resolved)));
}

/** Derivative antialiasing keeps the ink fine while the mesh bends it. */
export function terrainGrid(pigment: Node<"vec3">) {
  const point = positionWorld.xy;
  const derivative = fwidth(point).max(0.0001);
  const { majorStep, minorStep } = chartGrid(1);
  const line = (step: number) => {
    const distance = point
      .div(step)
      .add(0.5)
      .fract()
      .sub(0.5)
      .abs()
      .mul(step)
      .div(derivative);
    return float(1).sub(smoothstep(0.25, 0.85, min(distance.x, distance.y)));
  };
  const spacing = float(minorStep).div(derivative.y.max(derivative.x));
  const minor = line(minorStep)
    .mul(smoothstep(30, 60, spacing))
    .mul(0.16);
  const ink = line(majorStep).mul(0.3).max(minor);
  return mix(pigment, color("#78674e"), ink);
}
