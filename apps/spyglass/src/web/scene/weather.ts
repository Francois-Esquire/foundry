import {
  float,
  mx_noise_float,
  sin,
  smoothstep,
  uniform,
  vec2,
  vec3,
} from "three/tsl";
import type { Node } from "three/webgpu";
import type { ChartSettings } from "../settings/chart-settings";
import { sceneTime } from "./clock";
import type { SceneLayer } from "./handle";

/**
 * The weather: the chart's two animated decorations, both read off the
 * scene's clock. Surf breaks along each archipelago's rim in the water
 * material, and a cloud's shadow drifts over the paper and the sea in the
 * shared paper surface, its wisp lighter where the shade is strongest and set
 * off toward the sun. Neither carries data; each is a reader's toggle, and
 * reduced motion stills both by holding the clock.
 */

/** Whether each is drawn, 1 or 0, as the materials read it: a multiplier, so off is exact. */
export const weatherDrawn = { clouds: uniform(1), waves: uniform(1) };

/** Sets the two uniforms from the reader's settings. */
export function configureWeather(
  settings: Pick<ChartSettings, "clouds" | "waves">
): void {
  weatherDrawn.clouds.value = settings.clouds ? 1 : 0;
  weatherDrawn.waves.value = settings.waves ? 1 : 0;
}

/**
 * The surf band, in map units beyond the rim: nothing at the rim itself, full
 * at the crest, gone by the reach, so it lies just outside the rim line and
 * feathers both ways.
 */
export const surfBand = { crest: 5, reach: 16 } as const;
/** How far the surf lightens the water toward its ground at the crest of a wave. */
const surfStrength = 0.6;
/** The surf's cadence: the swell's and the chop's angular speeds in radians a second. */
const swellSpeed = 0.9;
const chopSpeed = 0.55;
/** Noise space per map unit for the surf's phase, so a patch of surf is some fifty units long. */
const surfPhaseScale = 0.02;
/** How fast the phase field drifts, in noise space a second, so the patches travel along the rim. */
const surfDrift = vec2(0.05, 0.03);

/**
 * Surf along the rim: 0 to 1, how far the water at a point is lightened.
 * `outside` is the distance beyond the nearest rim in map units; the band
 * (`surfBand`) is shaped from it, and its brightness is two sines of the
 * clock over a noise phase that varies along the rim and drifts, so patches
 * of foam brighten, fade and travel rather than the whole rim pulsing at
 * once. Multiplied by the waves uniform, so off is exactly nothing.
 */
export function rimSurf(
  outside: Node<"float">,
  point: Node<"vec2">
): Node<"float"> {
  const band = smoothstep(0, surfBand.crest, outside).mul(
    float(1).sub(smoothstep(surfBand.crest, surfBand.reach, outside))
  );
  const phase = mx_noise_float(
    point.mul(surfPhaseScale).add(surfDrift.mul(sceneTime))
  ).mul(6.3);
  const swell = sin(sceneTime.mul(swellSpeed).add(phase)).mul(0.5).add(0.5);
  const chop = sin(sceneTime.mul(chopSpeed).sub(phase.mul(1.7)))
    .mul(0.5)
    .add(0.5);
  return band
    .mul(swell.mul(0.6).add(chop.mul(0.4)))
    .mul(surfStrength)
    .mul(weatherDrawn.waves);
}

/** Noise space per map unit for the clouds: one period is some four hundred units, a few shapes across the chart. */
const cloudScale = 1 / 420;
/** The wind, in map units a second, in world coordinates. */
const wind = vec2(5, -2.5);
/** How fast a cloud's shape changes, in noise space a second. */
const cloudChange = 0.015;
/**
 * From a cloud to its shadow, in map units: away from the sun (`stage.ts`
 * sets it at (-600, 700, 700)), so the wisp sits sunward of its shade and
 * the two read as one thing.
 */
const shadowOffset = vec2(30, -35);
/**
 * The deepest a cloud's shade darkens the paper, and the most its wisp
 * lightens it, as factors in linear light: about half as much on the screen,
 * which is sRGB, so these are some four and three percent of a level.
 */
const cloudStrength = { shade: 0.09, wisp: 0.07 } as const;

/**
 * Cloud cover over a point, 0 to 1: two octaves of noise in chart space,
 * carried by the wind and slowly reshaping, kept to the noise's crests so the
 * cover is sparse, large and soft.
 */
function cloudCover(point: Node<"vec2">): Node<"float"> {
  const drifted = point.add(wind.mul(sceneTime)).mul(cloudScale);
  const change = sceneTime.mul(cloudChange);
  const broad = mx_noise_float(vec3(drifted, change));
  const detail = mx_noise_float(
    vec3(drifted.mul(2.3).add(7.1), change.mul(1.3))
  ).mul(0.45);
  return smoothstep(0.12, 0.4, broad.add(detail));
}

/**
 * The clouds' light over a point: a factor on the pigment, 1 where the sky is
 * clear, a few percent under a cloud's shade, a few percent over where its
 * wisp lies. The shade is the whole cover set off from the sun; the wisp is
 * only the cover's thickest part, in place, so the two sit apart and read as
 * a cloud and the shadow it casts rather than cancelling where they overlap.
 * Multiplied by the clouds uniform, so off is exactly 1.
 */
export function cloudLight(point: Node<"vec2">): Node<"float"> {
  const shade = cloudCover(point.sub(shadowOffset));
  const wisp = smoothstep(0.7, 1, cloudCover(point));
  return float(1).add(
    wisp
      .mul(cloudStrength.wisp)
      .sub(shade.mul(cloudStrength.shade))
      .mul(weatherDrawn.clouds)
  );
}

/**
 * The weather as a scene layer: nothing of its own to draw or update, since
 * the water and the paper read its uniforms, but it is the layer that moves,
 * so the frame loop runs while either decoration is on.
 */
export function createWeatherLayer(): SceneLayer & {
  configure: typeof configureWeather;
} {
  return {
    animating: () =>
      weatherDrawn.clouds.value > 0 || weatherDrawn.waves.value > 0,
    configure: configureWeather,
    dispose: () => {
      // The uniforms are the module's; the materials that read them dispose of themselves.
    },
    id: "weather",
  };
}
