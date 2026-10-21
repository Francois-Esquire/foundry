import {
  Color,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
} from "three";
import {
  float,
  fwidth,
  max,
  min,
  mix,
  positionWorld,
  pow,
  texture as sampleTexture,
  smoothstep,
  step,
  uniform,
  vec2,
} from "three/tsl";
import type { Node, UniformNode } from "three/webgpu";
import type { EmanationField } from "../../lib/visualization/archipelago-hull";
import type { GeologyGrid } from "../../lib/visualization/geology";

/**
 * The emanation round the archipelagos' outer hulls as material nodes: the
 * open water reads lighter round the islands and darkens toward the sea's
 * edge, stepping at each ring, and fine rings follow the
 * hull outward. Every tunable is a uniform, so the emanation can be tuned
 * live without a new shader.
 */
export const defaultOceanEmanationSettings = {
  /**
   * The water's depth as the optics read it, darkening from the hull to
   * the sea's edge. On and inside the hull, water deeper than `near.from`
   * metres keeps only `near.keep` of its depth past it, so the open sea
   * round the islands reads lighter than at the edge yet darker than any
   * shelf, and the escarpment's benches keep their order. Outward the
   * compression lifts and `far` metres are added by the sea's edge, shaped
   * by `exponent` over the gradient: the edge reads as the open abyss did
   * before. `terracing`, 0 to 1, steps the darkening at the rings rather
   * than spreading it smoothly.
   */
  depth: {
    exponent: 1.3,
    far: 1200,
    near: { from: 500, keep: 0.3 },
    terracing: 0.7,
  },
  /**
   * The rings' lines. `colour` is their ink; `strength` their peak
   * intensity, 0 to 1; `width` their width in screen pixels. They fade by
   * `fade` of their strength toward the sea's edge, start at ring `from`
   * (0 is the hull itself), and fade out where neighbouring rings come
   * closer than `spacing.to` screen pixels, gone at `spacing.from`.
   */
  rings: {
    colour: "#d6e6ea",
    fade: 0.6,
    from: 0,
    spacing: { from: 4, to: 14 },
    strength: 0.14,
    width: 1,
  },
};
export type OceanEmanationSettings = typeof defaultOceanEmanationSettings;

/** The emanation texture's channels, in RGBA order. */
export const emanationChannelLayout = [
  "ring",
  "gradient",
  "terraced",
  "distance",
] as const;

/**
 * Below this many coordinate units per pixel the ring field is flat: no
 * ring crosses it, so no line is drawn even where it rests on a ring.
 */
const flatFootprint = 1e-6;

/**
 * The emanation field as one half-float RGBA texture over the sea, in
 * `emanationChannelLayout` order, rows turned so the grid's first row, the
 * sea's top, is the texture's top. Half floats hold the ring coordinate to
 * about 1/64 of a gap at ring 16 and the distance to a few map units at
 * the sea's edge.
 */
export function createEmanationTexture(field: EmanationField) {
  const { height, width } = field;
  const stride = emanationChannelLayout.length;
  const data = new Uint16Array(width * height * stride);
  const channels = [field.ring, field.gradient, field.terraced, field.distance];
  for (let row = 0; row < height; row += 1) {
    const to = (height - 1 - row) * width * stride;
    for (let column = 0; column < width; column += 1) {
      const from = row * width + column;
      for (const [channel, values] of channels.entries()) {
        data[to + column * stride + channel] = DataUtils.toHalfFloat(
          values[from] ?? 0
        );
      }
    }
  }
  const texture = new DataTexture(
    data,
    width,
    height,
    RGBAFormat,
    HalfFloatType
  );
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  const grid: GeologyGrid = {
    cell: field.cell,
    height,
    left: field.left,
    top: field.top,
    width,
  };
  return {
    /** The extent the texture covers, in map units about the chart's centre. */
    extent: { height: height * field.cell, width: width * field.cell },
    grid,
    texture,
  };
}

/** The emanation's uniforms, one per tunable of `OceanEmanationSettings`. */
interface OceanEmanationUniforms {
  exponent: UniformNode<"float", number>;
  fade: UniformNode<"float", number>;
  far: UniformNode<"float", number>;
  from: UniformNode<"float", number>;
  keep: UniformNode<"float", number>;
  nearFrom: UniformNode<"float", number>;
  ringColour: UniformNode<"color", Color>;
  spacingFrom: UniformNode<"float", number>;
  spacingTo: UniformNode<"float", number>;
  strength: UniformNode<"float", number>;
  terracing: UniformNode<"float", number>;
  width: UniformNode<"float", number>;
}

/** Each uniform of `uniforms` set to the matching value of `settings`. */
function writeSettings(
  uniforms: OceanEmanationUniforms,
  settings: OceanEmanationSettings
): void {
  uniforms.exponent.value = Math.max(1e-3, settings.depth.exponent);
  uniforms.far.value = settings.depth.far;
  uniforms.nearFrom.value = settings.depth.near.from;
  uniforms.keep.value = settings.depth.near.keep;
  uniforms.terracing.value = settings.depth.terracing;
  uniforms.ringColour.value.set(settings.rings.colour);
  uniforms.fade.value = settings.rings.fade;
  uniforms.from.value = settings.rings.from;
  uniforms.spacingFrom.value = settings.rings.spacing.from;
  uniforms.spacingTo.value = settings.rings.spacing.to;
  uniforms.strength.value = settings.rings.strength;
  uniforms.width.value = settings.rings.width;
}

/**
 * The texture coordinate of a world position over the emanation's extent,
 * centred on the chart. World y is map y turned over, and the texture's
 * rows are turned, so world y rises with the texture's v.
 */
export function emanationTexturePoint(
  extent: { height: number; width: number },
  point: Node<"vec2"> = positionWorld.xy
): Node<"vec2"> {
  return vec2(
    point.x.div(extent.width).add(0.5),
    point.y.div(extent.height).add(0.5)
  );
}

/** Antialiased lines at every integer of `ring`, `width` screen pixels wide, faded where rings crowd on screen. */
function ringLines(
  ring: Node<"float">,
  uniforms: OceanEmanationUniforms
): Node<"float"> {
  const footprint = fwidth(ring);
  const pixels = ring
    .add(0.5)
    .fract()
    .sub(0.5)
    .abs()
    .div(max(footprint, flatFootprint));
  const half = max(uniforms.width, 1).mul(0.5);
  const line = float(1).sub(smoothstep(half.sub(0.5), half.add(0.5), pixels));
  const resolved = smoothstep(
    uniforms.spacingFrom,
    uniforms.spacingTo,
    float(1).div(max(footprint, flatFootprint))
  ).mul(step(flatFootprint, footprint));
  return line.mul(min(uniforms.width, 1)).mul(resolved);
}

/** The emanation at a world position as nodes, with the uniforms they read. */
export interface OceanEmanationNodes {
  /** Writes `settings` into the uniforms. */
  configure: (settings: OceanEmanationSettings) => void;
  dispose: () => void;
  /** Signed map units from the nearest hull, negative inside one. */
  distance: Node<"float">;
  /** 0 on and inside the hull, rising to 1 at the sea's edge. */
  gradient: Node<"float">;
  /** The rings' line intensity, 0 to `strength`, to mix toward `ringColour` over the water: the wireframe layer's opacity. */
  ring: Node<"float">;
  /** The rings' ink in linear light. */
  ringColour: Node<"color">;
  uniforms: OceanEmanationUniforms;
  /** The nominal metres the optics should read for water `depth` metres deep: compressed near the hull, deepened toward the sea's edge. */
  waterDepth: (depth: Node<"float">) => Node<"float">;
}

/**
 * The emanation at `point`, by default the world position: the depth the
 * optics read, lighter near the hull and darker toward the sea's edge,
 * ring lines that keep
 * their width in screen pixels and fade as they crowd, and the gradient
 * itself. `extent` is the texture's, from `createEmanationTexture`.
 */
export function oceanEmanationNode(options: {
  extent: { height: number; width: number };
  point?: Node<"vec2">;
  settings?: OceanEmanationSettings;
  texture: DataTexture;
}): OceanEmanationNodes {
  const { extent, settings = defaultOceanEmanationSettings } = options;
  const uniforms: OceanEmanationUniforms = {
    exponent: uniform(1),
    fade: uniform(0),
    far: uniform(0),
    from: uniform(0),
    keep: uniform(1),
    nearFrom: uniform(0),
    ringColour: uniform(new Color(settings.rings.colour)),
    spacingFrom: uniform(0),
    spacingTo: uniform(0),
    strength: uniform(0),
    terracing: uniform(0),
    width: uniform(1),
  };
  writeSettings(uniforms, settings);
  const texel = sampleTexture(
    options.texture,
    emanationTexturePoint(extent, options.point)
  );
  const ringCoordinate = texel.r;
  const gradient = texel.g.clamp(0, 1);
  const shaped = mix(gradient, texel.b.clamp(0, 1), uniforms.terracing);
  const deepening = uniforms.far.mul(pow(shaped, uniforms.exponent));
  const compression = float(1).sub(uniforms.keep).mul(float(1).sub(shaped));
  const waterDepth = (depth: Node<"float">) =>
    depth
      .sub(max(depth.sub(uniforms.nearFrom), 0).mul(compression))
      .add(deepening);
  const ring = ringLines(ringCoordinate, uniforms)
    .mul(step(uniforms.from.sub(0.5), ringCoordinate))
    .mul(float(1).sub(uniforms.fade.mul(gradient)))
    .mul(uniforms.strength);
  return {
    configure: (next) => writeSettings(uniforms, next),
    dispose() {
      for (const node of Object.values(uniforms)) {
        node.dispose();
      }
    },
    distance: texel.a,
    gradient,
    ring,
    ringColour: uniforms.ringColour,
    uniforms,
    waterDepth,
  };
}
