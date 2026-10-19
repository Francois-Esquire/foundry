import {
  float,
  mx_noise_float,
  sin,
  smoothstep,
  uniform,
  vec2,
  vec3,
} from "three/tsl";
import type { Node, UniformNode } from "three/webgpu";
import type { ChartSettings } from "../settings/chart-settings";
import { isSceneLayerVisible } from "../settings/scene-composition";
import type { SceneClock } from "./clock";
import type { SceneLayer } from "./handle";
import { surfaceMotionNormal } from "./surface-motion";

/**
 * Water effects share the scene clock. The original drifting-light recipe is
 * preserved, but the sea material masks it to fixed dependency foundations.
 * Only the illumination moves; membership and bathymetry never animate.
 * Reduced motion holds the clock and composition gates each effect.
 */

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

/** Original drift recipe: keep these values when adding other water or sky effects. */
/** Noise space per map unit: one period is some four hundred units. */
const driftScale = 1 / 420;
/** Drift in map units a second, in world coordinates. */
const driftVelocity = vec2(5, -2.5);
/** How fast the shape changes, in noise space a second. */
const driftChange = 0.015;
/**
 * Offset between the light and shade, in map units. Retained from the
 * original cloud-shadow effect, whose lighting informed its direction.
 */
const shadowOffset = vec2(30, -35);
/**
 * The deepest the shade darkens the paper, and the most its wisp
 * lightens it, as factors in linear light: about half as much on the screen,
 * which is sRGB, so these are some four and three percent of a level.
 */
const driftStrength = { shade: 0.09, wisp: 0.07 } as const;

/** The materials' surf and subsurface drift as nodes over the clock. */
export interface WeatherNodes {
  /**
   * Drifting light over a point: a factor on the pigment, 1 where absent,
   * a few percent under in shade and over where its wisp lies. Off is 1.
   */
  driftLight: (point: Node<"vec2">) => Node<"float">;
  /**
   * Surf along the rim: 0 to 1, how far the water at a point is lightened.
   * `outside` is the distance beyond the nearest rim in map units.
   * Multiplied by the waves uniform, so off is exactly nothing.
   */
  rimSurf: (outside: Node<"float">, point: Node<"vec2">) => Node<"float">;
  /** World-space normal from uneven wave trains; off is the flat sea normal. */
  surfaceNormal: (point: Node<"vec2">) => Node<"vec3">;
}

/**
 * The weather as a scene layer: nothing of its own to draw or update, since
 * the water and the paper read its nodes, but it owns the effects'
 * uniforms, and it is the layer that moves, so the frame loop runs while
 * a visible effect is on.
 */
export interface Weather extends SceneLayer, WeatherNodes {
  /** Combines the reader's toggles with effect isolation. */
  configure: (
    settings: Pick<ChartSettings, "clouds" | "waves" | "composition">
  ) => void;
  /** Whether each is drawn, 1 or 0, as the materials read it: a multiplier, so off is exact. */
  drawn: {
    drift: UniformNode<"float", number>;
    surf: UniformNode<"float", number>;
    surface: UniformNode<"float", number>;
  };
}

/**
 * Drift field over a point, 0 to 1: two octaves of moving noise in chart
 * space, slowly reshaping, kept to the crests so it is sparse and soft.
 */
function driftField(
  point: Node<"vec2">,
  time: SceneClock["time"]
): Node<"float"> {
  const drifted = point.add(driftVelocity.mul(time)).mul(driftScale);
  const change = time.mul(driftChange);
  const broad = mx_noise_float(vec3(drifted, change));
  const detail = mx_noise_float(
    vec3(drifted.mul(2.3).add(7.1), change.mul(1.3))
  ).mul(0.45);
  return smoothstep(0.12, 0.4, broad.add(detail));
}

/** The weather over `clock`, all effects on until configured. */
export function createWeatherLayer(
  clock: Pick<SceneClock, "time">,
  consumers: () => {
    sea: boolean;
    foundations: boolean;
  } = () => ({
    foundations: true,
    sea: true,
  })
): Weather {
  const { time } = clock;
  const drawn = { drift: uniform(1), surf: uniform(1), surface: uniform(1) };
  /**
   * The band (`surfBand`) is shaped from the distance beyond the rim, and
   * its brightness is two sines of the clock over a noise phase that varies
   * along the rim and drifts, so patches of foam brighten, fade and travel
   * rather than the whole rim pulsing at once.
   */
  const rimSurf: WeatherNodes["rimSurf"] = (outside, point) => {
    const band = smoothstep(0, surfBand.crest, outside).mul(
      float(1).sub(smoothstep(surfBand.crest, surfBand.reach, outside))
    );
    const phase = mx_noise_float(
      point.mul(surfPhaseScale).add(surfDrift.mul(time))
    ).mul(6.3);
    const swell = sin(time.mul(swellSpeed).add(phase)).mul(0.5).add(0.5);
    const chop = sin(time.mul(chopSpeed).sub(phase.mul(1.7)))
      .mul(0.5)
      .add(0.5);
    return band
      .mul(swell.mul(0.6).add(chop.mul(0.4)))
      .mul(surfStrength)
      .mul(drawn.surf);
  };
  /**
   * The shade uses the whole field, offset from its brightest crests. Keep
   * both lobes and their offset: they give the effect its submerged feel.
   */
  const driftLight: WeatherNodes["driftLight"] = (point) => {
    const shade = driftField(point.sub(shadowOffset), time);
    const wisp = smoothstep(0.7, 1, driftField(point, time));
    return float(1).add(
      wisp
        .mul(driftStrength.wisp)
        .sub(shade.mul(driftStrength.shade))
        .mul(drawn.drift)
    );
  };
  const surfaceNormal: WeatherNodes["surfaceNormal"] = (point) =>
    surfaceMotionNormal(point, time, drawn.surface);
  return {
    animating: () => {
      const visible = consumers();
      return (
        (drawn.drift.value > 0 && visible.foundations && visible.sea) ||
        ((drawn.surf.value > 0 || drawn.surface.value > 0) && visible.sea)
      );
    },
    configure(settings) {
      drawn.surface.value =
        settings.waves &&
        isSceneLayerVisible(settings.composition, "surface-motion")
          ? 1
          : 0;
      drawn.drift.value =
        settings.clouds &&
        isSceneLayerVisible(settings.composition, "dependency-foundations") &&
        isSceneLayerVisible(settings.composition, "subsurface-drift")
          ? 1
          : 0;
      drawn.surf.value =
        settings.waves && isSceneLayerVisible(settings.composition, "rim-surf")
          ? 1
          : 0;
    },
    dispose() {
      drawn.drift.dispose();
      drawn.surf.dispose();
      drawn.surface.dispose();
    },
    drawn,
    driftLight,
    id: "weather",
    kind: "layer",
    rimSurf,
    surfaceNormal,
  };
}
