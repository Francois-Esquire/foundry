import { Color, Vector3 } from "three";
import { float, max, mix, vec3 } from "three/tsl";
import type { Node } from "three/webgpu";
import { materials as lit } from "../ladder/ink-ladder";

/**
 * The geology preview's terrain light, computed in the node graph of an
 * unlit material so the seabed is lit before the water sees it: a warm key
 * from the scene's sun with a wrapped Lambert response, a cool sky ambient
 * that creases and overhangs lose, and the sun's own visibility over the
 * relief's horizon. The light is divided by its value on level, open
 * ground, so a level seabed keeps its albedo exactly and the water optics'
 * calibration over pale sand holds; only slopes, creases and shade move
 * away from it.
 */
export const defaultTerrainLightSettings = {
  /**
   * Overall brightness of the lit terrain against level, open ground: 1
   * keeps the legend's calibration.
   */
  exposure: 1,
  /**
   * A soft fill on land: each channel darker than level, open ground is
   * lifted this share of the way back to it, so an escarpment turned from
   * the sun stays a soft, readable shade rather than going muddy. The
   * seabed takes none; the water's optics calibrate its light.
   */
  fill: { land: 0.3, seabed: 0 },
  /**
   * The key light: the scene's sun, warm, from the northwest. `strength` is
   * against the sky's 1, so at 3.2 level ground takes about four fifths of
   * its light from the sun and a face turned away keeps only the sky.
   */
  key: { colour: lit.light.sun, strength: 3.2 },
  /**
   * How far the normal's slope is multiplied for light alone, on land and
   * on the seabed: the seabed's relief is gentle against its exaggerated
   * height, so its plates would read flat without it.
   */
  relief: { land: 1.3, seabed: 8 },
  /**
   * The sky's ambient, cool, as sRGB hex. A face turned to the ground sees
   * `ground` of it.
   */
  sky: { colour: "#c4dcf0", ground: 0.55, strength: 1 },
  /**
   * Wrapped Lambert: a face goes dark this far past grazing, as a share of
   * a right angle, so terminators are soft and risers turned from the sun
   * keep their shape.
   */
  wrap: 0.3,
};
export type TerrainLightSettings = typeof defaultTerrainLightSettings;

/** The direction toward the scene's sun, x right, y up the chart and z up: `createLitScene`'s sun position, normalised. */
export const sunDirection = new Vector3(-600, 700, 700).normalize();

/** One wrapped Lambert response, 0 to 1, for a cosine to the sun. */
function wrapped(cosine: number, wrap: number): number {
  return Math.min(1, Math.max(0, (cosine + wrap) / (1 + wrap)));
}

/**
 * The terrain's light, as a linear-light multiplier of albedo: level, open
 * ground at `exposure` in every channel. `normal` is the geometric normal,
 * its slope multiplied by `relief` for light; `sky` and `sun` are the
 * shares of each the relief lets through, 0 to 1. `fill`, 0 by default,
 * lifts any channel under `exposure` that share of the way back to it.
 */
export function terrainLightNode(options: {
  fill?: Node<"float"> | number;
  normal: Node<"vec3">;
  relief: Node<"float"> | number;
  settings?: TerrainLightSettings;
  sky: Node<"float">;
  sun: Node<"float">;
}): Node<"vec3"> {
  const { settings = defaultTerrainLightSettings } = options;
  const key = new Color(settings.key.colour).multiplyScalar(
    settings.key.strength
  );
  const sky = new Color(settings.sky.colour).multiplyScalar(
    settings.sky.strength
  );
  const level = wrapped(sunDirection.z, settings.wrap);
  const balance = new Color(
    1 / (sky.r + key.r * level),
    1 / (sky.g + key.g * level),
    1 / (sky.b + key.b * level)
  ).multiplyScalar(settings.exposure);
  const geometric = options.normal.normalize();
  const normal = vec3(
    geometric.xy.mul(options.relief),
    max(geometric.z, float(0))
  ).normalize();
  const facing = normal
    .dot(vec3(sunDirection.x, sunDirection.y, sunDirection.z))
    .add(settings.wrap)
    .div(1 + settings.wrap)
    .clamp(0, 1);
  const hemisphere = mix(
    float(settings.sky.ground),
    float(1),
    normal.z.mul(0.5).add(0.5)
  );
  const ambient = vec3(sky.r, sky.g, sky.b).mul(hemisphere).mul(options.sky);
  const direct = vec3(key.r, key.g, key.b).mul(facing).mul(options.sun);
  const light = ambient.add(direct).mul(vec3(balance.r, balance.g, balance.b));
  if (options.fill === undefined) {
    return light;
  }
  return light.add(
    max(vec3(settings.exposure).sub(light), vec3(0)).mul(options.fill)
  );
}

/**
 * The light `terrainLightNode` gives, on the CPU, for tests and reference
 * renders: the same formula over plain numbers.
 */
export function terrainLight(options: {
  fill?: number;
  normal: readonly [number, number, number];
  relief: number;
  settings?: TerrainLightSettings;
  sky: number;
  sun: number;
}): [number, number, number] {
  const { settings = defaultTerrainLightSettings } = options;
  const key = new Color(settings.key.colour).multiplyScalar(
    settings.key.strength
  );
  const sky = new Color(settings.sky.colour).multiplyScalar(
    settings.sky.strength
  );
  const level = wrapped(sunDirection.z, settings.wrap);
  const [nx, ny, nz] = options.normal;
  const length = Math.hypot(nx, ny, nz) || 1;
  const normal = new Vector3(
    (nx / length) * options.relief,
    (ny / length) * options.relief,
    Math.max(0, nz / length)
  ).normalize();
  const facing = wrapped(normal.dot(sunDirection), settings.wrap);
  const hemisphere =
    settings.sky.ground + (1 - settings.sky.ground) * (normal.z * 0.5 + 0.5);
  const fill = options.fill ?? 0;
  const channel = (skyChannel: number, keyChannel: number) => {
    const light =
      (settings.exposure *
        (skyChannel * hemisphere * options.sky +
          keyChannel * facing * options.sun)) /
      (skyChannel + keyChannel * level);
    return light + Math.max(0, settings.exposure - light) * fill;
  };
  return [channel(sky.r, key.r), channel(sky.g, key.g), channel(sky.b, key.b)];
}
