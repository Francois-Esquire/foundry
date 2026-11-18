import type { MapPassName } from "../maps/map-params";
import { clamp01 } from "../maps/uniforms";

export type Rgb = readonly [number, number, number];

export function hexToLinear(hex: string): Rgb {
  const channel = (at: number) => {
    const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return [channel(1), channel(3), channel(5)];
}

function toSrgbByte(linear: number): number {
  const c = Math.min(1, Math.max(0, linear));
  const encoded = c <= 0.003_130_8 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

export function linearToHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((c) => toSrgbByte(c).toString(16).padStart(2, "0")).join("")}`;
}

export interface SeaMapParams {
  bandDeep: Rgb;
  bandShallows: Rgb;
  bandShelf: Rgb;
  bandShore: Rgb;
  bandSlope: Rgb;
  bandTrench: Rgb;
  bankBeach: number;
  bankBottomReach: number;
  bankBridge: number;
  bankDeep: number;
  bankDeepRings: number;
  bankHull: number;
  bankLift: number;
  bankLiftTread: number;
  bankMargin: number;
  bankMerge: number;
  bankMoat: number;
  bankMoatAmount: number;
  bankRagged: number;
  bankRun: number;
  bankScarp: number;
  bankSlope: number;
  bankSpread: number;
  bankStep: number;
  bankTaper: number;
  bankTop: number;
  bankTopReach: number;
  bankUndulation: number;
  bankUndulationAngle: number;
  bankUndulationBend: number;
  bankUndulationLength: number;
  bankUndulationShift: number;
  bankUndulationSteps: number;
  bankWander: number;
  floorTint: number;
  sandColor: Rgb;
  seascapeBasins: number;
  seascapeCanyons: number;
  seascapeDescent: number;
  seascapeFaults: number;
  seascapeHills: number;
  seascapePits: number;
  seascapeReach: number;
  seascapeScale: number;
  seascapeSeed: number;
  seascapeSills: number;
  seascapeStep: number;
  seascapeVeer: number;
  sedimentDrift: number;
  shadowBlur: number;
  shelfWidth: number;
  shoreCliffDepth: number;
  shoreCliffWidth: number;
  shoreCove: number;
  shoreCoveDepth: number;
  shoreSandDepth: number;
  shoreSandHeight: number;
  shoreSmallSand: number;
  shoreSmallSize: number;
  siltColor: Rgb;
  swellAzimuth: number;
  swellHeight: number;
  swellLength: number;
}

interface SeaFrameParams {
  caustics: number;
  clarity: number;
  cliffWash: number;
  debrisPebbles: number;
  debrisRings: number;
  debrisShells: number;
  debrisSize: number;
  debrisStacks: number;
  depthCurve: number;
  floorSpecks: number;
  haze: number;
  hazeFar: Rgb;
  hazeNear: Rgb;
  reflection: number;
  refraction: number;
  refractionReach: number;
  rippleSpacing: number;
  sandRipples: number;
  seaLineColor: Rgb;
  seaLines: number;
  seaRelief: number;
  seaRim: number;
  seascapeRelief: number;
  shadowAmbient: number;
  shoalGlow: number;
  speckColor: Rgb;
  speckDensity: number;
  speckSize: number;
  specular: number;
  surf: number;
  surfSpacing: number;
  swash: number;
  swashPeriod: number;
  swashReach: number;
  visibleDepth: number;
  washPeriod: number;
  washWidth: number;
  waterDeep: Rgb;
  waterLegend: number;
  waterShallow: Rgb;
  waveAmplitude: number;
  waveScale: number;
  waveSpeed: number;
  waveSpread: number;
  wetSand: number;
}

export type SeaParams = SeaMapParams & SeaFrameParams;

export const DEFAULT_SEA_PARAMS: SeaParams = {
  bandDeep: hexToLinear("#0c3f6f"),
  bandShallows: hexToLinear("#4fd8cf"),
  bandShelf: hexToLinear("#1fb2c2"),
  bandShore: hexToLinear("#d2f6e8"),
  bandSlope: hexToLinear("#11769c"),
  bandTrench: hexToLinear("#051a38"),
  bankBeach: 16,
  bankBottomReach: 2,
  bankBridge: 40,
  bankDeep: 24,
  bankDeepRings: 6,
  bankHull: 0.35,
  bankLift: 0.3,
  bankLiftTread: 30,
  bankMargin: 15,
  bankMerge: 80,
  bankMoat: 0.25,
  bankMoatAmount: 0.5,
  bankRagged: 0.6,
  bankRun: 3,
  bankScarp: 0.5,
  bankSlope: 0.4,
  bankSpread: 80,
  bankStep: 4,
  bankTaper: 0.96,
  bankTop: 2,
  bankTopReach: 0.2,
  bankUndulation: 0.4,
  bankUndulationAngle: 45,
  bankUndulationBend: 0.6,
  bankUndulationLength: 80,
  bankUndulationShift: 0.45,
  bankUndulationSteps: 3,
  bankWander: 0.25,
  caustics: 1,
  clarity: 3,
  cliffWash: 1,
  debrisPebbles: 0.35,
  debrisRings: 1,
  debrisShells: 0.3,
  debrisSize: 1,
  debrisStacks: 0.03,
  depthCurve: 2,
  floorSpecks: 0.8,
  floorTint: 0.75,
  haze: 0.04,
  hazeFar: hexToLinear("#ffd6a3"),
  hazeNear: hexToLinear("#b8ccdb"),
  reflection: 0.6,
  refraction: 0.6,
  refractionReach: 18,
  rippleSpacing: 4,
  sandColor: hexToLinear("#f3e8c7"),
  sandRipples: 0.6,
  seaLineColor: hexToLinear("#a6eef0"),
  seaLines: 0.32,
  seaRelief: 0.9,
  seaRim: 1,
  seascapeBasins: 40,
  seascapeCanyons: 40,
  seascapeDescent: 0.035,
  seascapeFaults: 12,
  seascapeHills: 0.35,
  seascapePits: 0.3,
  seascapeReach: 4,
  seascapeRelief: 0.8,
  seascapeScale: 900,
  seascapeSeed: 1,
  seascapeSills: 0.6,
  seascapeStep: 1.12,
  seascapeVeer: 0.6,
  sedimentDrift: 8,
  shadowAmbient: 0.45,
  shadowBlur: 0.002,
  shelfWidth: 150,
  shoalGlow: 0.4,
  shoreCliffDepth: 50,
  shoreCliffWidth: 3,
  shoreCove: 6,
  shoreCoveDepth: 0.75,
  shoreSandDepth: 18,
  shoreSandHeight: 0.8,
  shoreSmallSand: 0.25,
  shoreSmallSize: 100,
  siltColor: hexToLinear("#66807f"),
  speckColor: hexToLinear("#f0c060"),
  speckDensity: 0.25,
  speckSize: 3.5,
  specular: 0.6,
  surf: 1.25,
  surfSpacing: 3,
  swash: 1,
  swashPeriod: 5,
  swashReach: 0.4,
  swellAzimuth: 4.4,
  swellHeight: 1,
  swellLength: 40,
  visibleDepth: 40,
  washPeriod: 3.5,
  washWidth: 6,
  waterDeep: [0.003_347, 0.0185, 0.080_22],
  waterLegend: 1,
  waterShallow: [0.078_19, 0.4508, 0.521],
  waveAmplitude: 1,
  waveScale: 12,
  waveSpeed: 1,
  waveSpread: 1,
  wetSand: 0.8,
};

export const MAP_OF_SEA_MAP_PARAM: Record<keyof SeaMapParams, MapPassName> = {
  bandDeep: "paint",
  bandShallows: "paint",
  bandShelf: "paint",
  bandShore: "paint",
  bandSlope: "paint",
  bandTrench: "paint",
  bankBeach: "height",
  bankBottomReach: "height",
  bankBridge: "height",
  bankDeep: "height",
  bankDeepRings: "height",
  bankHull: "height",
  bankLift: "height",
  bankLiftTread: "height",
  bankMargin: "height",
  bankMerge: "height",
  bankMoat: "height",
  bankMoatAmount: "height",
  bankRagged: "height",
  bankRun: "height",
  bankScarp: "height",
  bankSlope: "height",
  bankSpread: "height",
  bankStep: "height",
  bankTaper: "height",
  bankTop: "height",
  bankTopReach: "height",
  bankUndulation: "height",
  bankUndulationAngle: "height",
  bankUndulationBend: "height",
  bankUndulationLength: "height",
  bankUndulationShift: "height",
  bankUndulationSteps: "height",
  bankWander: "height",
  floorTint: "paint",
  sandColor: "paint",
  seascapeBasins: "height",
  seascapeCanyons: "height",
  seascapeDescent: "height",
  seascapeFaults: "height",
  seascapeHills: "height",
  seascapePits: "height",
  seascapeReach: "seabed",
  seascapeScale: "height",
  seascapeSeed: "height",
  seascapeSills: "height",
  seascapeStep: "height",
  seascapeVeer: "height",
  sedimentDrift: "flow",
  shadowBlur: "light",
  shelfWidth: "height",
  shoreCliffDepth: "height",
  shoreCliffWidth: "height",
  shoreCove: "height",
  shoreCoveDepth: "height",
  shoreSandDepth: "height",
  shoreSandHeight: "height",
  shoreSmallSand: "height",
  shoreSmallSize: "height",
  siltColor: "paint",
  swellAzimuth: "flow",
  swellHeight: "flow",
  swellLength: "flow",
};

export function pick<T, K extends keyof T>(
  source: T,
  keys: readonly K[]
): Pick<T, K> {
  const picked = {} as Pick<T, K>;
  for (const key of keys) {
    picked[key] = source[key];
  }
  return picked;
}

export const SEA_KEYS = Object.keys(DEFAULT_SEA_PARAMS) as (keyof SeaParams)[];

const SEA_MAP_KEYS = Object.keys(
  MAP_OF_SEA_MAP_PARAM
) as (keyof SeaMapParams)[];

export const SEA_COLORS = [
  "sandColor",
  "siltColor",
  "bandShore",
  "bandShallows",
  "bandShelf",
  "bandSlope",
  "bandDeep",
  "bandTrench",
  "waterShallow",
  "waterDeep",
  "speckColor",
  "seaLineColor",
  "hazeNear",
  "hazeFar",
] as const satisfies readonly (keyof SeaParams)[];

export const seaMapParamsOf = (sea: Readonly<SeaMapParams>): SeaMapParams =>
  pick(sea, SEA_MAP_KEYS);

export interface SeaDepths {
  readonly floor: number;
  readonly platform: number;
  readonly top: number;
}

export type SeaDepthParams = Pick<
  SeaMapParams,
  "bankDeep" | "bankStep" | "bankTaper" | "bankTop"
>;

export const taperOf = (sea: SeaDepthParams): number =>
  Math.min(Math.max(sea.bankTaper, 0), 1);

function levelRise(sea: SeaDepthParams, level: number): number {
  const step = Math.max(sea.bankStep, 0);
  const taper = taperOf(sea);
  const count = level + 1;
  if (taper >= 1) {
    return step * count;
  }
  return (step * (1 - taper ** count)) / (1 - taper);
}

export function seaDepthsOf(sea: SeaDepthParams, levels: number): SeaDepths {
  const top = Math.max(sea.bankTop, 0);
  const platform = top + (levels > 0 ? levelRise(sea, levels - 1) : 0);
  return { floor: platform + Math.max(sea.bankDeep, 0), platform, top };
}

export type SeaBands = readonly (readonly [number, number, number, number])[];

export function seaBandsOf(
  sea: SeaDepthParams &
    Pick<
      SeaMapParams,
      | "bandDeep"
      | "bandShallows"
      | "bandShelf"
      | "bandShore"
      | "bandSlope"
      | "bandTrench"
    >,
  levels: number
): SeaBands {
  const { top, platform, floor } = seaDepthsOf(sea, levels);
  const band = (color: Rgb, depth: number) =>
    [color[0], color[1], color[2], depth] as const;
  return [
    band(sea.bandShore, 0),
    band(sea.bandShallows, Math.max(top, 0.5)),
    band(sea.bandShelf, Math.max(SHELF_SHARE * platform, top + 0.5)),
    band(sea.bandSlope, platform + SLOPE_SHARE * (floor - platform)),
    band(sea.bandDeep, Math.max(floor, platform + 1)),
    band(sea.bandTrench, Math.max(TRENCH_SCALE * floor, platform + 2)),
  ];
}

export function floorPaintOf(
  sea: Parameters<typeof seaBandsOf>[0] &
    Pick<SeaMapParams, "floorTint" | "sandColor" | "siltColor">,
  levels: number
) {
  return {
    bands: seaBandsOf(sea, levels),
    sand: sea.sandColor,
    silt: sea.siltColor,
    siltDepth: Math.max(seaDepthsOf(sea, levels).platform, 1),
    tint: clamp01(sea.floorTint),
  };
}

const SHELF_SHARE = 0.5;
const SLOPE_SHARE = 0.4;
const TRENCH_SCALE = 2;

export function swellHeading(azimuth: number): [number, number] {
  return [-Math.sin(azimuth), Math.cos(azimuth)];
}

const BREAK_RATIO = 1.3;
const GRAVITY = 9.81;

export const breakDepth = (swellHeight: number): number =>
  BREAK_RATIO * Math.max(swellHeight, 0);

export const surfSpeed = (swellHeight: number): number =>
  Math.sqrt(GRAVITY * breakDepth(swellHeight));
