import {
  type DepthBandId,
  depthBands,
  geologyLevels,
  nominalDepth,
} from "../../lib/visualization/geology";

/**
 * Water optics: the colour of a column of sea over its seabed, as a
 * reference model the sea material ports formula for formula
 * (`scene/water-optics.ts`). Light crosses the column by Beer–Lambert
 * absorption per channel, so red goes first, then green, and blue reaches
 * farthest; what the seabed does not return, the water scatters back in its
 * own colour; and the surface reflects a little sky. Everything is in linear
 * RGB; hex is only the way in and out.
 */

/** A colour as three linear-light channels, red, green and blue. */
export type RGB = readonly [number, number, number];

export interface WaterOptics {
  /**
   * Absorption per optical metre, red, green and blue. Within the knee an
   * optical metre is a metre, so these read as clear tropical water's
   * diffuse attenuation would.
   */
  absorption: RGB;
  /**
   * The optical depth the column's light crosses at a nominal depth `d`:
   * `knee · ((1 + d / knee)^exponent − 1) / exponent`. It is true metres
   * in water much shallower than the knee and grows as a power of the
   * depth beyond it, so the 0 to 6,000 m of a chart span shallows the
   * seabed shows through, a shelf it still shows on, a slope it barely
   * shows on and an abyss it never does. As the exponent falls to 0 it is
   * the logarithm `knee · ln(1 + d / knee)`; it must stay above 0.
   */
  opticalDepth: { exponent: number; knee: number };
  /** The palette's anchors: the seabed it is read over and the depth each band is read at. */
  palette: {
    /** Each band's representative depth in nominal metres. */
    depths: Record<DepthBandId, number>;
    /** A pale coral sand, sRGB hex. */
    seabed: string;
  };
  /** The fraction of the sky the surface reflects: water's normal-incidence Fresnel reflectance. */
  reflectance: number;
  /**
   * The colour the water scatters back where the seabed's light is lost,
   * linear: the colour of an infinitely deep column.
   */
  scatter: RGB;
  /**
   * Metres of water over which the surface comes into being at the
   * shoreline: at the waterline there is no reflection, so the water is
   * wholly transparent and meets the land as bare seabed.
   */
  shorelineRamp: number;
  /** The sky the surface reflects, linear. */
  sky: RGB;
  /**
   * Below `from` metres the column darkens by `exp(−(d − from) / length)`.
   * This is a chart convention, not optics: deep water's colour stops
   * changing a few hundred metres down, so without it a trench would read
   * as the abyss does. It starts at the trench band, so every shallower
   * band is the optical model alone.
   */
  twilight: { from: number; length: number };
}

/** Where a band without a floor is read: halfway to the deepest a feature carves. */
const deepestDepth = nominalDepth(geologyLevels.trenchFloor);

/** Where the trench band begins, in nominal metres: where the twilight starts. */
const trenchTop = depthBands.find(({ id }) => id === "trench")?.from ?? 3000;

/** Each band's middle depth; the open-ended trench ends at the deepest carved floor. */
function bandMiddles(): Record<DepthBandId, number> {
  const depths = {} as Record<DepthBandId, number>;
  for (const band of depthBands) {
    const to = Number.isFinite(band.to) ? band.to : deepestDepth;
    depths[band.id] = (band.from + to) / 2;
  }
  return depths;
}

/**
 * Calibrated over the palette's sand so the six bands read as the legend
 * does: pale turquoise shoreline, vibrant aqua shallows, a teal-blue shelf,
 * cobalt slope, ultramarine deep and navy trench.
 */
export const defaultWaterOptics: WaterOptics = {
  absorption: [0.17, 0.021, 0.016],
  opticalDepth: { exponent: 0.25, knee: 20 },
  palette: { depths: bandMiddles(), seabed: "#f1ead8" },
  reflectance: 0.02,
  scatter: [0.007, 0.002, 0.23],
  shorelineRamp: 5,
  sky: [0.3, 0.5, 0.8],
  twilight: { from: trenchTop, length: 1000 },
};

/** The smallest exponent the optical depth takes, so it never divides by 0. */
export const minimumExponent = 1e-3;

/** An sRGB channel, 0 to 1, in linear light: the piecewise sRGB curve. */
function linearChannel(value: number): number {
  return value <= 0.040_45 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** A linear channel in sRGB, 0 to 1, clamped. */
function srgbChannel(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped <= 0.003_130_8
    ? clamped * 12.92
    : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

/** An sRGB hex colour, `#rrggbb`, in linear light. */
export function linearFromHex(hex: string): RGB {
  const digits = hex.replace("#", "");
  const channel = (offset: number) =>
    linearChannel(Number.parseInt(digits.slice(offset, offset + 2), 16) / 255);
  return [channel(0), channel(2), channel(4)];
}

/** A linear colour as sRGB hex, each channel clamped to 0 to 1. */
export function hexFromLinear(colour: RGB): string {
  return `#${colour
    .map((channel) =>
      Math.round(srgbChannel(channel) * 255)
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`;
}

/** The optical depth over `depth` nominal metres; land and the waterline are 0. */
export function opticalDepth(
  depth: number,
  optics: WaterOptics = defaultWaterOptics
): number {
  const { knee } = optics.opticalDepth;
  const exponent = Math.max(minimumExponent, optics.opticalDepth.exponent);
  const metres = Math.max(0, depth);
  return (knee * ((1 + metres / knee) ** exponent - 1)) / exponent;
}

/** The fraction of each channel's light that crosses the column: `exp(−σ·τ)`. */
export function transmittance(
  depth: number,
  optics: WaterOptics = defaultWaterOptics
): RGB {
  const tau = opticalDepth(depth, optics);
  const [red, green, blue] = optics.absorption;
  return [Math.exp(-red * tau), Math.exp(-green * tau), Math.exp(-blue * tau)];
}

/** The twilight's darkening at `depth`: 1 above `twilight.from`, falling beyond it. */
export function twilightLight(
  depth: number,
  optics: WaterOptics = defaultWaterOptics
): number {
  const { from, length } = optics.twilight;
  return Math.exp(-Math.max(0, depth - from) / length);
}

/**
 * How much of the seabed shows at `depth`, 1 at the waterline to 0 in the
 * abyss: the transmittance of the channel that reaches farthest, under the
 * twilight. Contours and seabed detail fade by it, so they go as the
 * seabed's own colour does.
 */
export function seabedVisibility(
  depth: number,
  optics: WaterOptics = defaultWaterOptics
): number {
  const clearest = Math.min(...optics.absorption);
  return (
    Math.exp(-clearest * opticalDepth(depth, optics)) *
    twilightLight(depth, optics)
  );
}

/** The share of the surface's reflection at `depth`: 0 at the waterline, full by the ramp's end. */
function surfaceShare(depth: number, optics: WaterOptics): number {
  const ramp = Math.min(1, Math.max(0, depth / optics.shorelineRamp));
  return optics.reflectance * ramp;
}

/**
 * The water's colour over a seabed of `seabedAlbedo` (linear) at `depth`
 * nominal metres, linear: the seabed through the column, `T·albedo`, the
 * water's own scatter where the seabed's light is lost, `(1 − T)·scatter`,
 * both under the twilight, and the sky the surface reflects over that.
 */
export function waterColour(
  seabedAlbedo: RGB,
  depth: number,
  optics: WaterOptics = defaultWaterOptics
): RGB {
  const through = transmittance(depth, optics);
  const light = twilightLight(depth, optics);
  const surface = surfaceShare(depth, optics);
  const channel = (index: 0 | 1 | 2) => {
    const t = through[index];
    const below =
      light * (t * seabedAlbedo[index] + (1 - t) * optics.scatter[index]);
    return (1 - surface) * below + surface * optics.sky[index];
  };
  return [channel(0), channel(1), channel(2)];
}

/** One band of the legend, with its colour over the palette's sand. */
export interface DepthSwatch {
  /** sRGB hex. */
  colour: string;
  /** Nominal metres the colour is read at. */
  depth: number;
  id: DepthBandId;
  label: string;
}

/** The legend's six swatches, shallow to deep: each band's water over the palette's sand. */
export function depthPalette(
  optics: WaterOptics = defaultWaterOptics
): DepthSwatch[] {
  const seabed = linearFromHex(optics.palette.seabed);
  return depthBands.map(({ id, label }) => {
    const depth = optics.palette.depths[id];
    return {
      colour: hexFromLinear(waterColour(seabed, depth, optics)),
      depth,
      id,
      label,
    };
  });
}
