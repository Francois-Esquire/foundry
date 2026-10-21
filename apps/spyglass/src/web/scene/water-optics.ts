import { Vector3 } from "three";
import { exp, float, max, min, mix, pow, uniform, vec3 } from "three/tsl";
import type { Node, UniformNode } from "three/webgpu";
import {
  defaultWaterOptics,
  minimumExponent,
  type RGB,
  type WaterOptics,
} from "../layout/water-optics";

/**
 * The water optics of `layout/water-optics.ts` as material nodes, formula
 * for formula: Beer–Lambert transmittance over the optical depth, the
 * water's scatter where the seabed's light is lost, the twilight's turn
 * toward navy below the slope's middle, and the sky over the shoreline's
 * ramp. Every tunable is a
 * uniform, so the water can be tuned live without a new shader.
 */

/** The optics as uniforms, one per tunable of `WaterOptics` the formula reads. */
interface WaterOpticsUniforms {
  absorption: UniformNode<"vec3", Vector3>;
  exponent: UniformNode<"float", number>;
  knee: UniformNode<"float", number>;
  reflectance: UniformNode<"float", number>;
  scatter: UniformNode<"vec3", Vector3>;
  shorelineRamp: UniformNode<"float", number>;
  sky: UniformNode<"vec3", Vector3>;
  twilightColour: UniformNode<"vec3", Vector3>;
  twilightFrom: UniformNode<"float", number>;
  twilightLength: UniformNode<"float", number>;
}

/** The water over a seabed as nodes, with the uniforms they read. */
export interface WaterOpticsNodes {
  /** The water's colour in linear light. */
  colour: Node<"vec3">;
  /** Writes `optics` into the uniforms. */
  configure: (optics: WaterOptics) => void;
  dispose: () => void;
  uniforms: WaterOpticsUniforms;
  /** How much of the seabed shows, 0 to 1, as `seabedVisibility`. */
  visibility: Node<"float">;
}

const vector = ([red, green, blue]: RGB) => new Vector3(red, green, blue);

/** Each uniform of `uniforms` set to the matching value of `optics`. */
function writeOptics(uniforms: WaterOpticsUniforms, optics: WaterOptics) {
  uniforms.absorption.value.set(...optics.absorption);
  uniforms.scatter.value.set(...optics.scatter);
  uniforms.sky.value.set(...optics.sky);
  uniforms.twilightColour.value.set(...optics.twilight.colour);
  uniforms.exponent.value = Math.max(
    minimumExponent,
    optics.opticalDepth.exponent
  );
  uniforms.knee.value = optics.opticalDepth.knee;
  uniforms.reflectance.value = optics.reflectance;
  uniforms.shorelineRamp.value = optics.shorelineRamp;
  uniforms.twilightFrom.value = optics.twilight.from;
  uniforms.twilightLength.value = optics.twilight.length;
}

/**
 * The water over `seabedColour` (linear) at `depth` nominal metres. Land and
 * the waterline, at or above 0, are bare seabed and fully visible.
 */
export function waterOpticsNode(options: {
  depth: Node<"float">;
  optics?: WaterOptics;
  seabedColour: Node<"vec3">;
}): WaterOpticsNodes {
  const { seabedColour, optics = defaultWaterOptics } = options;
  const uniforms: WaterOpticsUniforms = {
    absorption: uniform(vector(optics.absorption)),
    exponent: uniform(0),
    knee: uniform(0),
    reflectance: uniform(0),
    scatter: uniform(vector(optics.scatter)),
    shorelineRamp: uniform(0),
    sky: uniform(vector(optics.sky)),
    twilightColour: uniform(vector(optics.twilight.colour)),
    twilightFrom: uniform(0),
    twilightLength: uniform(0),
  };
  writeOptics(uniforms, optics);
  const depth = max(float(0), options.depth);
  const { absorption, knee, exponent } = uniforms;
  const tau = knee
    .mul(pow(float(1).add(depth.div(knee)), exponent).sub(1))
    .div(exponent);
  const through = exp(absorption.negate().mul(tau));
  const light = exp(
    max(float(0), depth.sub(uniforms.twilightFrom))
      .div(uniforms.twilightLength)
      .negate()
  );
  const column = seabedColour
    .mul(through)
    .add(uniforms.scatter.mul(through.oneMinus()));
  const below = mix(uniforms.twilightColour, column, light);
  const surface = uniforms.reflectance.mul(
    depth.div(uniforms.shorelineRamp).clamp(0, 1)
  );
  const colour = mix(below, uniforms.sky, surface);
  const clearest = min(absorption.x, min(absorption.y, absorption.z));
  const visibility = exp(clearest.negate().mul(tau)).mul(light);
  return {
    colour: vec3(colour),
    configure: (next) => writeOptics(uniforms, next),
    dispose() {
      for (const node of Object.values(uniforms)) {
        node.dispose();
      }
    },
    uniforms,
    visibility,
  };
}
