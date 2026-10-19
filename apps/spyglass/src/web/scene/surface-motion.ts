import {
  cos,
  float,
  fwidth,
  mx_noise_float,
  smoothstep,
  vec2,
  vec3,
} from "three/tsl";
import type { Node } from "three/webgpu";
import type { SceneClock } from "./clock";

/** Angular frequency per map unit, travel speed, and slope of each wave band. */
const waveBands = [
  { direction: [0.94, 0.34], frequency: 0.043, slope: 0.07, speed: 0.36 },
  { direction: [0.78, -0.63], frequency: 0.079, slope: 0.045, speed: 0.61 },
  { direction: [0.98, 0.2], frequency: 0.14, slope: 0.025, speed: 0.9 },
  { direction: [0.36, 0.93], frequency: 0.25, slope: 0.012, speed: 1.17 },
] as const;

/**
 * Uneven wave trains, anchored in world space. A slowly moving noise field bends
 * and breaks up the crests; a separate envelope leaves calmer patches between
 * them. This only changes lighting normals, not geometry or map coordinates.
 */
export function surfaceMotionNormal(
  point: Node<"vec2">,
  time: SceneClock["time"],
  enabled: Node<"float">
): Node<"vec3"> {
  const drifted = point.sub(vec2(1.8, 0.6).mul(time));
  const warp = vec2(
    mx_noise_float(drifted.mul(0.012)),
    mx_noise_float(drifted.mul(0.009).add(vec2(17.3, -9.2)))
  );
  const envelope = smoothstep(
    -0.45,
    0.55,
    mx_noise_float(drifted.mul(0.006).add(vec2(-31.7, 12.8)))
  )
    .mul(0.8)
    .add(0.2);
  const footprint = fwidth(point);
  let slope: Node<"vec2"> = vec2(0);
  for (const [index, band] of waveBands.entries()) {
    const direction = vec2(...band.direction);
    const phase = point
      .dot(direction)
      .mul(band.frequency)
      .add(
        warp.dot(vec2(band.direction[1], band.direction[0])).mul(3.5 + index)
      )
      .sub(time.mul(band.speed))
      .add(index * 2.4);
    // Fade each band before its crests become subpixel, rather than turning
    // all detail on or off together as the camera moves.
    const phasePerPixel = footprint
      .dot(vec2(Math.abs(band.direction[0]), Math.abs(band.direction[1])))
      .mul(band.frequency);
    const resolved = float(1).sub(smoothstep(0.5, 1.8, phasePerPixel));
    const crest = cos(phase).mul(band.slope).mul(resolved);
    slope = slope.add(direction.mul(crest));
  }
  return vec3(slope.mul(envelope).mul(enabled).negate(), 1).normalize();
}
