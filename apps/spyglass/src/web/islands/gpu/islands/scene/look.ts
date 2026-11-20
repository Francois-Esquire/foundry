import { WATER_WAVES } from "../../../shaders/water/spectrum";
import type { DebrisDensity } from "../land/debris";
import type { MapParams, ViewedMap } from "../maps/map-params";
import { clamp01, landUniform, sunDirection } from "../maps/uniforms";
import type { IslandsSettings } from "../params";
import type { Banks } from "../sea/banks";
import {
  floorPaintOf,
  hexToLinear,
  pick,
  type Rgb,
  SEA_COLORS,
  SEA_KEYS,
  type SeaBands,
  type SeaParams,
  seaBandsOf,
  seaDepthsOf,
  seaMapParamsOf,
  surfSpeed,
  swellHeading,
} from "../sea/sea-params";

const RESOLUTION: Record<
  IslandsSettings["resolution"],
  MapParams["resolution"]
> = { "512": 512, "1024": 1024, "2048": 2048 };

function seaParamsOf(settings: IslandsSettings): SeaParams {
  const colors = Object.fromEntries(
    SEA_COLORS.map((key) => [key, hexToLinear(settings[key])])
  ) as Record<(typeof SEA_COLORS)[number], Rgb>;
  return { ...pick(settings, SEA_KEYS), ...colors };
}

export function mapParamsOf(settings: IslandsSettings): MapParams {
  return {
    ...seaMapParamsOf(seaParamsOf(settings)),
    crownHeight: settings.crownHeight,
    crownWidth: settings.crownWidth,
    feather: settings.feather,
    fileRadius: settings.fileRadius,
    lipHeight: settings.lipHeight,
    lipWidth: settings.lipWidth,
    palette: settings.palette,
    plateHeight: settings.plateHeight,
    resolution: RESOLUTION[settings.resolution],
    rimSmoothing: settings.rimSmoothing,
    rimWidth: settings.rimWidth,
    sunAzimuth: settings.sunAzimuth,
    sunElevation: settings.sunElevation,
    tileWorldSize: settings.tileWorldSize,
  };
}

type ChartWave = readonly [number, number, number, number];

const CHART_WAVE_COUNT = 32;
const LENGTH_STEP = 0.754_877_666_2;
const ANGLE_STEP = 0.569_840_290_998;

function chartWaves(
  scale: number,
  heading: readonly [number, number],
  spread: number
): readonly ChartWave[] {
  const shared = WATER_WAVES.map(([kx, kz, , amplitude]) => ({
    amplitude,
    length: (2 * Math.PI) / Math.hypot(kx, kz),
  })).sort((a, b) => b.length - a.length);
  const longest = shared[0]?.length ?? 1;
  const shortest = shared.at(-1)?.length ?? longest;
  const share = Math.sqrt(CHART_WAVE_COUNT / shared.length);
  const along = Math.atan2(heading[1], heading[0]);
  return Array.from({ length: CHART_WAVE_COUNT }, (_, i) => {
    const t = (i + ((0.5 + i * LENGTH_STEP) % 1)) / CHART_WAVE_COUNT;
    const length = longest * (shortest / longest) ** t;
    const angle = along + spread * (2 * ((0.5 + i * ANGLE_STEP) % 1) - 1);
    const k = (2 * Math.PI) / (length * scale);
    return [
      Math.cos(angle) * k,
      Math.sin(angle) * k,
      Math.sqrt(DISPERSION * k * scale),
      (sharedAmplitude(shared, length) * scale) / share,
    ];
  });
}

const DISPERSION = 1.1;

function sharedAmplitude(
  shared: readonly { length: number; amplitude: number }[],
  length: number
): number {
  for (let i = 1; i < shared.length; i += 1) {
    const long = shared[i - 1];
    const short = shared[i];
    if (!(long && short)) {
      continue;
    }
    if (length >= short.length) {
      const t =
        Math.log(length / long.length) / Math.log(short.length / long.length);
      return long.amplitude * (short.amplitude / long.amplitude) ** t;
    }
  }
  return shared.at(-1)?.amplitude ?? 0;
}

export interface Look {
  readonly absorption: Rgb;
  readonly antialias: boolean;
  readonly bands: SeaBands;
  readonly bloom: number;
  readonly bloomRadius: number;
  readonly bloomThreshold: number;
  readonly bounce: Rgb;
  readonly bounceStrength: number;
  readonly causticSize: number;
  readonly caustics: number;
  readonly clarity: number;
  readonly debris: DebrisDensity;
  readonly debrisRings: number;
  readonly depthCurve: number;
  readonly depthPower: number;
  readonly distanceReach: number;
  readonly files: number;
  readonly floorDepth: number;
  readonly floorPaint: ReturnType<typeof floorPaintOf>;
  readonly flowSpeed: number;
  readonly grass: number;
  readonly grassDry: Rgb;
  readonly grassLush: Rgb;
  readonly grassSheen: number;
  readonly gustSize: number;
  readonly haze: number;
  readonly hazeFar: Rgb;
  readonly hazeNear: Rgb;
  readonly highlight: number;
  readonly highlightColor: Rgb;
  readonly highlightDim: number;
  readonly highlightMembers: number;
  readonly highlightOutline: number;
  readonly land: Readonly<ReturnType<typeof landUniform>>;
  readonly landTop: number;
  readonly legend: number;
  readonly occlusion: number;
  readonly occlusionSun: number;
  readonly openFloor: Rgb;
  readonly reflection: number;
  readonly refraction: number;
  readonly refractionReach: number;
  readonly relief: number;
  readonly renderScale: number;
  readonly rim: number;
  readonly rippleSpacing: number;
  readonly ripples: number;
  readonly rock: Rgb;
  readonly rockTint: number;
  readonly sandHeight: number;
  readonly scatter: Rgb;
  readonly seaFill: Rgb;
  readonly seaLine: Rgb;
  readonly seaLines: number;
  readonly seascapeDescent: number;
  readonly seascapeRelief: number;
  readonly seascapeStep: number;
  readonly shadowAmbient: number;
  readonly shadowStrength: number;
  readonly shoalGlow: number;
  readonly shoalReach: number;
  readonly skyColor: Rgb;
  readonly skyHorizon: Rgb;
  readonly skyStrength: number;
  readonly skyZenith: Rgb;
  readonly slopeWidth: number;
  readonly softLight: number;
  readonly speck: Rgb;
  readonly speckDensity: number;
  readonly speckSize: number;
  readonly specks: number;
  readonly specular: number;
  readonly sun: Rgb;
  readonly sunColor: Rgb;
  readonly sunStrength: number;
  readonly surf: number;
  readonly surfSpacing: number;
  readonly surfSpeed: number;
  readonly swash: number;
  readonly swashPeriod: number;
  readonly swashReach: number;
  readonly time: number;
  readonly top: number;
  readonly view: "shaded" | ViewedMap;
  readonly vignette: number;
  readonly vignetteColor: Rgb;
  readonly wash: number;
  readonly washPeriod: number;
  readonly washWidth: number;
  readonly water: boolean;
  readonly waveStrength: number;
  readonly waves: readonly ChartWave[];
  readonly wetSand: number;
  readonly wind: number;
  readonly windHeading: readonly [number, number];
  readonly windSpeed: number;
}

const GOLDEN_SUN: Rgb = [1, 0.84, 0.64];
const NOON_SUN: Rgb = [1, 0.97, 0.92];
const NOON_SKY: Rgb = [0.66, 0.77, 0.9];
const KEY_ON_FLAT = 0.76;
const KEY_MOST = 2.4;

const DARKEST = 1e-3;
const VISIBLE_SHARE = 0.1;
const DEPTH_POWER = [0.05, 8] as const;

interface WaterOptics {
  readonly absorption: Rgb;
  readonly clarity: number;
  readonly depthCurve: number;
  readonly depthPower: number;
}

function waterOptics(
  sea: Pick<
    SeaParams,
    "clarity" | "depthCurve" | "visibleDepth" | "waterShallow"
  >
): WaterOptics {
  const clarity = Math.max(sea.clarity, 1e-3);
  const depth = (c: number) => -Math.log(Math.max(c, DARKEST));
  const absorption: Rgb = [
    depth(sea.waterShallow[0]),
    depth(sea.waterShallow[1]),
    depth(sea.waterShallow[2]),
  ];
  const grey = Math.max(Math.min(...absorption), 1e-4);
  const ratio = Math.log(Math.max(sea.visibleDepth, 1e-3) / clarity);
  const wanted = Math.log(Math.log(1 / VISIBLE_SHARE) / grey);
  const power = Math.abs(ratio) < 1e-6 ? 1 : wanted / ratio;
  return {
    absorption,
    clarity,
    depthCurve: Math.max(sea.depthCurve, 0),
    depthPower: Math.min(Math.max(power, DEPTH_POWER[0]), DEPTH_POWER[1]),
  };
}

const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

function sunlight(
  sun: Rgb,
  settings: Pick<IslandsSettings, "skyColor" | "sunStrength" | "sunWarmth">
) {
  const height = clamp01(sun[1]);
  const t = clamp01((Math.asin(height) - 0.45) / 0.65);
  const noon = t * t * (3 - 2 * t);
  const [r, g, b] = mixRgb(NOON_SUN, GOLDEN_SUN, settings.sunWarmth);
  const warm: Rgb = [Math.max(r, 0), Math.max(g, 0), Math.max(b, 0)];
  return {
    skyColor: mixRgb(hexToLinear(settings.skyColor), NOON_SKY, noon),
    sunColor: mixRgb(warm, NOON_SUN, noon),
    sunStrength: Math.min(
      KEY_MOST,
      (KEY_ON_FLAT * settings.sunStrength) / Math.max(height, 0.15)
    ),
  };
}

export function lookOf(
  settings: IslandsSettings,
  banks: Pick<Banks, "levels">,
  time: number,
  options: { water?: boolean } = {}
): Look {
  const sea = seaParamsOf(settings);
  const shaded = settings.view === "shaded";
  const depths = seaDepthsOf(sea, banks.levels);
  const bands = seaBandsOf(sea, banks.levels);
  const sun = sunDirection(settings.sunAzimuth, settings.sunElevation);
  const deep = bands[4] ?? [0, 0, 0, 0];
  const flowSpeed = surfSpeed(sea.swellHeight);
  return {
    ...sunlight(sun, settings),
    ...waterOptics(sea),
    antialias: shaded && settings.antialias,
    bands,
    bloom: shaded ? Math.max(settings.bloom, 0) : 0,
    bloomRadius: Math.max(settings.bloomRadius, 0),
    bloomThreshold: Math.max(settings.bloomThreshold, 0),
    bounce: hexToLinear(settings.bounceColor),
    bounceStrength: Math.max(settings.bounce, 0),
    causticSize: Math.max(sea.waveScale, 1),
    caustics: Math.max(sea.caustics, 0),
    debris: {
      pebbles: Math.max(sea.debrisPebbles, 0),
      shells: Math.max(sea.debrisShells, 0),
      size: Math.max(sea.debrisSize, 0),
      stacks: Math.max(sea.debrisStacks, 0),
    },
    debrisRings: Math.max(sea.debrisRings, 0),
    distanceReach: Math.max(2 * sea.shelfWidth, 8),
    files: clamp01(settings.fileStrength),
    floorDepth: depths.floor,
    floorPaint: floorPaintOf(sea, banks.levels),
    flowSpeed,
    grass: clamp01(settings.grass),
    grassDry: hexToLinear(settings.grassDry),
    grassLush: hexToLinear(settings.grassLush),
    grassSheen: Math.max(settings.grassSheen, 0),
    gustSize: Math.max(settings.gustSize, 1),
    haze: sea.haze,
    hazeFar: sea.hazeFar,
    hazeNear: sea.hazeNear,
    highlight: clamp01(settings.highlight),
    highlightColor: hexToLinear(settings.highlightColor),
    highlightDim: clamp01(settings.highlightDim),
    highlightMembers: clamp01(settings.highlightMembers),
    highlightOutline: clamp01(settings.highlightOutline),
    land: landUniform(settings),
    landTop: settings.plateHeight + settings.lipHeight + settings.crownHeight,
    legend: clamp01(sea.waterLegend),
    occlusion: Math.max(settings.occlusion, 0),
    occlusionSun: clamp01(settings.occlusionSun),
    openFloor: mixRgb(
      sea.siltColor,
      [deep[0], deep[1], deep[2]],
      clamp01(sea.floorTint)
    ),
    reflection: sea.reflection,
    refraction: sea.refraction,
    refractionReach: Math.max(sea.refractionReach, 0),
    relief: clamp01(sea.seaRelief),
    renderScale: settings.renderScale,
    rim: Math.max(sea.seaRim, 0),
    rippleSpacing: Math.max(sea.rippleSpacing, 0.1),
    ripples: Math.max(sea.sandRipples, 0),
    rock: hexToLinear(settings.rockColor),
    rockTint: clamp01(settings.rockTint),
    sandHeight: sea.shoreSandHeight,
    scatter: sea.waterDeep,
    seaFill: hexToLinear(settings.seaFill),
    seaLine: sea.seaLineColor,
    seaLines: sea.seaLines,
    seascapeDescent: Math.max(sea.seascapeDescent, 0),
    seascapeRelief: clamp01(sea.seascapeRelief),
    seascapeStep: Math.max(sea.seascapeStep, 1),
    shadowAmbient: clamp01(sea.shadowAmbient),
    shadowStrength: clamp01(settings.shadowStrength),
    shoalGlow: sea.shoalGlow,
    shoalReach: Math.max(sea.bankBeach, 1),
    skyHorizon: sea.hazeFar,
    skyStrength: settings.skyFill,
    skyZenith: hexToLinear(settings.skyColor),
    slopeWidth: Math.max(sea.shelfWidth, 0),
    softLight: settings.softLight,
    speck: sea.speckColor,
    speckDensity: clamp01(sea.speckDensity),
    speckSize: Math.max(sea.speckSize, 0.1),
    specks: clamp01(sea.floorSpecks),
    specular: sea.specular,
    sun,
    surf: Math.max(sea.surf, 0),
    surfSpacing: Math.max(sea.surfSpacing, 0.5),
    surfSpeed: flowSpeed * sea.waveSpeed,
    swash: Math.max(sea.swash, 0),
    swashPeriod: Math.max(sea.swashPeriod, 0.5),
    swashReach: Math.max(sea.swashReach, 0),
    time,
    top: depths.top,
    view: settings.view,
    vignette: settings.vignette,
    vignetteColor: hexToLinear(settings.vignetteColor),
    wash: Math.max(sea.cliffWash, 0),
    washPeriod: Math.max(sea.washPeriod, 0.5),
    washWidth: Math.max(sea.washWidth, 0),
    water: shaded && (options.water ?? true),
    waveStrength: sea.waveAmplitude,
    waves: chartWaves(
      sea.waveScale,
      swellHeading(sea.swellAzimuth),
      sea.waveSpread
    ),
    wetSand: clamp01(sea.wetSand),
    wind: Math.max(settings.wind, 0),
    windHeading: swellHeading(sea.swellAzimuth),
    windSpeed: Math.max(settings.windSpeed, 0),
  };
}

export function floorColorOf(look: Look): Rgb {
  const direct = Math.max(look.sun[1], 0) * look.sunStrength;
  const light = (i: 0 | 1 | 2) =>
    look.sunColor[i] * direct + look.skyColor[i] * look.skyStrength;
  return [
    look.openFloor[0] * light(0),
    look.openFloor[1] * light(1),
    look.openFloor[2] * light(2),
  ];
}

export const animates = (look: Look): boolean =>
  look.water && look.waveStrength > 0;
