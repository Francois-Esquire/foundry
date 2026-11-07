/**
 * From the settings to what the GPU reads: the `SeaParams`, the
 * `MapParams` a build takes, and the frame's `Look`. Pure, and free of
 * `vgpu`, so tests and the headless tools derive exactly what the browser
 * does.
 */
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

/**
 * The sea's parameters out of the settings. The names match; the colours
 * change form, from a picker's sRGB hex to linear channels. A colour
 * missing from `SEA_COLORS` would stay a string, which `SeaParams` refuses.
 */
function seaParamsOf(settings: IslandsSettings): SeaParams {
  const colors = Object.fromEntries(
    SEA_COLORS.map((key) => [key, hexToLinear(settings[key])])
  ) as Record<(typeof SEA_COLORS)[number], Rgb>;
  return { ...pick(settings, SEA_KEYS), ...colors };
}

/**
 * The map parameters out of the settings: the land's, and the sea's map
 * side. The names match; some values change form: `resolution` is a
 * select's string and the colours a picker's sRGB hex, where `MapParams`
 * wants a number and linear channels.
 */
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

/** One wave of the spectrum: kx, kz (radians per chart unit), angular frequency, amplitude. */
type ChartWave = readonly [number, number, number, number];

/** Waves in the chart's spectrum (sea/surface.wgsl's `waves` array). */
const CHART_WAVE_COUNT = 32;
/** Low-discrepancy steps for each wave's length and direction: R2's. */
const LENGTH_STEP = 0.754_877_666_2;
const ANGLE_STEP = 0.569_840_290_998;

/**
 * The chart's waves: the shared spectrum's range of lengths (water/spectrum.ts,
 * sized for /pond's toy boats) at `scale` chart units per unit of it, as
 * `CHART_WAVE_COUNT` waves, so no few of them line up into a lattice as
 * the view pulls back. Their lengths fill the range evenly in log, each
 * jittered within its share; their directions spread `spread` radians
 * either side of `heading` (the way the wind blows, chart x, y), stratified
 * so every direction is covered; each takes the shared spectrum's
 * amplitude at its length, over the square root of how many waves share
 * that length's octave, so the sea's slope variance is the shared one's.
 * Deep-water dispersion sets each one's speed.
 */
function chartWaves(
  scale: number,
  heading: readonly [number, number],
  spread: number
): readonly ChartWave[] {
  const shared = WATER_WAVES.map(([kx, kz, , amplitude]) => ({
    amplitude,
    length: (2 * Math.PI) / Math.hypot(kx, kz),
  })).sort((a, b) => b.length - a.length);
  // The shared spectrum is a fixed, non-empty list, so the fallback never applies.
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

/** Deep-water dispersion in the shared spectrum's units: ω² = this · k. */
const DISPERSION = 1.1;

/** The shared spectrum's amplitude at `length`, between its waves in log. */
function sharedAmplitude(
  shared: readonly { length: number; amplitude: number }[],
  length: number
): number {
  for (let i = 1; i < shared.length; i += 1) {
    const long = shared[i - 1];
    const short = shared[i];
    // Both indexes stay within the list; the guard only narrows the types.
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

/** What a frame is drawn with, besides the camera and the maps. */
export interface Look {
  /**
   * Per channel, the water's optical depth at `clarity`: the floor's
   * light is `exp(-absorption)` there, the shallow colour (`waterOptics`).
   */
  readonly absorption: Rgb;
  /** The post's anti-aliasing (FXAA) runs: the shaded view only, so the debug views show their maps exactly. */
  readonly antialias: boolean;
  /** The chart's legend: each band's colour and the depth it is reached at. */
  readonly bands: SeaBands;
  /**
   * The post's bloom: its strength (0 for none), the linear brightness it
   * starts at, and how wide it spreads.
   */
  readonly bloom: number;
  readonly bloomRadius: number;
  readonly bloomThreshold: number;
  /** Warm light thrown up off sunlit sand and shallows onto cliffs. */
  readonly bounce: Rgb;
  readonly bounceStrength: number;
  /** The caustics' cells, chart units: the waves' scale. */
  readonly causticSize: number;
  /** Light focused by the ripples on the shallow floor; 0 for none. */
  readonly caustics: number;
  /** The depth at which the floor is seen at the shallow colour, chart units. */
  readonly clarity: number;
  /** The props on the shallows: what placement keeps (debris.ts). */
  readonly debris: DebrisDensity;
  /** The foam rings round the sea stacks, 0 for none. */
  readonly debrisRings: number;
  /** The tint's curve: the hue's optical depth goes as `rho^depthCurve` (`waterOptics`). */
  readonly depthCurve: number;
  /**
   * The brightness's power: the optical depth goes as `(depth /
   * clarity)^depthPower`, set by `visibleDepth` (`waterOptics`).
   */
  readonly depthPower: number;
  /** The distance view's ramp saturates this far from the coast. */
  readonly distanceReach: number;
  /** How strongly the files show on the shaded ground, 0–1; 0 reads nothing. */
  readonly files: number;
  /**
   * The deep floor's depth, derived from the chart's level count
   * (sea-params.ts `seaDepthsOf`): the open floor past the mesh, and the
   * height view's ramp.
   */
  readonly floorDepth: number;
  /** The floor's colour by depth (sea-params.ts `floorPaintOf`): the open floor past the frame. */
  readonly floorPaint: ReturnType<typeof floorPaintOf>;
  /** The flow view's full brightness: the surf's transport, chart units per second. */
  readonly flowSpeed: number;
  /** The turf on the tops, 0–1 in place of the caps, its colours and its sheen. */
  readonly grass: number;
  readonly grassDry: Rgb;
  readonly grassLush: Rgb;
  readonly grassSheen: number;
  /** The gusts' run over the turf, chart units, and their speed a second. */
  readonly gustSize: number;
  /** The haze's optical depth per eye height of distance past the first. */
  readonly haze: number;
  readonly hazeFar: Rgb;
  readonly hazeNear: Rgb;
  /** The selection's fill, outline, a chosen ring's islands' share of the fill, their colour, and how much the rest dims. */
  readonly highlight: number;
  readonly highlightColor: Rgb;
  readonly highlightDim: number;
  readonly highlightMembers: number;
  readonly highlightOutline: number;
  /** The land's profile (land.wgsl `Land`), which the terrain rebuilds at its vertices. */
  readonly land: Readonly<ReturnType<typeof landUniform>>;
  /** The land's highest: the plate, its lip and its crown. */
  readonly landTop: number;
  /** How far the water's own colour is the legend at the floor's depth rather than `scatter`, 0–1. */
  readonly legend: number;
  /** The open floor past the mesh, unlit: silt tinted by the deep band. */
  /** The baked occlusion's power (1 as baked), and the share of it the sun takes too. */
  readonly occlusion: number;
  readonly occlusionSun: number;
  readonly openFloor: Rgb;
  readonly reflection: number;
  readonly refraction: number;
  /** The most thickness the refraction moves the floor sample by. */
  readonly refractionReach: number;
  /** How strongly the floor's relief shades the water's colour; 0 for none. */
  readonly relief: number;
  /** The film's size against the output, 0–1. */
  readonly renderScale: number;
  /** How bright each riser's sunward rim is through the water; 0 for none. */
  readonly rim: number;
  readonly rippleSpacing: number;
  /** The sand ripples' strength on the shallow floor, and their spacing, chart units. */
  readonly ripples: number;
  /** The cliff rock on the land's steep rim, before its island's tint. */
  readonly rock: Rgb;
  /** How far the rock takes its island's hue, 0–1. */
  readonly rockTint: number;
  /** The sand's height above the water at the coast. */
  readonly sandHeight: number;
  readonly scatter: Rgb;
  /** The fill from below, off the sea, on undersides and lee faces. */
  readonly seaFill: Rgb;
  readonly seaLine: Rgb;
  readonly seaLines: number;
  /** How far the open floor sinks per chart unit out from the coasts. */
  readonly seascapeDescent: number;
  /** How far the open sea's floor keeps its relief through the deep, 0–1. */
  readonly seascapeRelief: number;
  /** Each of the open floor's steps' depth against the one above, at least 1. */
  readonly seascapeStep: number;
  /** How much of the water's own light survives in the land's shadow on it, 0–1. */
  readonly shadowAmbient: number;
  /** How much sun a cast shadow takes away, 0–1. */
  readonly shadowStrength: number;
  readonly shoalGlow: number;
  /** How far off a coast the glow of the sand under its beach reaches. */
  readonly shoalReach: number;
  readonly skyColor: Rgb;
  readonly skyHorizon: Rgb;
  readonly skyStrength: number;
  readonly skyZenith: Rgb;
  /**
   * The platform's slope's width past its escarpment (map-uniforms.ts
   * `heightUniforms` `bed.slopeWidth`): where the open sea's floor takes over.
   */
  readonly slopeWidth: number;
  /** How far the sun wraps round gentle ground. */
  readonly softLight: number;
  readonly speck: Rgb;
  readonly speckDensity: number;
  readonly speckSize: number;
  /** The gold specks' strength, their cell, the share of cells holding one, and colour. */
  readonly specks: number;
  readonly specular: number;
  readonly sun: Rgb;
  readonly sunColor: Rgb;
  readonly sunStrength: number;
  readonly surf: number;
  readonly surfSpacing: number;
  /** How fast the surf's crests roll ashore, chart units a second. */
  readonly surfSpeed: number;
  /** The swash up a beach: its strength, how high it runs, seconds between swashes, and how dark the sand it wets. */
  readonly swash: number;
  readonly swashPeriod: number;
  readonly swashReach: number;
  /** Seconds of wave motion: advanced only while the waves are on. */
  readonly time: number;
  /** The highest level's depth. */
  readonly top: number;
  readonly view: "shaded" | ViewedMap;
  readonly vignette: number;
  readonly vignetteColor: Rgb;
  /** The wash against a wall: its strength, how far out its rings spread, and seconds between them. */
  readonly wash: number;
  readonly washPeriod: number;
  readonly washWidth: number;
  /** The water composite runs: the shaded view, unless `water` is off. */
  readonly water: boolean;
  readonly waveStrength: number;
  /** The wave spectrum at the chart's scale (sea surface `waveScale`). */
  readonly waves: readonly ChartWave[];
  readonly wetSand: number;
  /** The wind over the turf: how hard, the way it blows (the swell's) and how fast. */
  readonly wind: number;
  readonly windHeading: readonly [number, number];
  readonly windSpeed: number;
}

const GOLDEN_SUN: Rgb = [1, 0.84, 0.64];
const NOON_SUN: Rgb = [1, 0.97, 0.92];
const NOON_SKY: Rgb = [0.66, 0.77, 0.9];
/** What the key adds to a flat, open, sunlit face, at any elevation. */
const KEY_ON_FLAT = 0.76;
/** The key never outshines this, however low the sun. */
const KEY_MOST = 2.4;

/** Transmittance below this would absorb without bound. */
const DARKEST = 1e-3;
/** The share of the floor's light still seen at `visibleDepth`, clearest channel. */
const VISIBLE_SHARE = 0.1;
/** The brightness's power is held in this range, whatever the depths ask. */
const DEPTH_POWER = [0.05, 8] as const;

/** How the water passes the floor's light: `Look`'s water terms. */
interface WaterOptics {
  readonly absorption: Rgb;
  readonly clarity: number;
  readonly depthCurve: number;
  readonly depthPower: number;
}

/**
 * The water's optics from the sea's surface parameters, in chart units of
 * depth. Per channel the floor's light through `z` units of water is
 * `exp(-tau)`, with the optical depth
 *
 *   rho   = (z / clarity)^p
 *   tau_c = grey * rho + (a_c - grey) * rho^depthCurve
 *
 * where `a_c = -ln(waterShallow_c)` (the optical depth at `clarity`) and
 * `grey` is the least of them, the clearest channel's: the part every
 * channel shares, the floor's brightness. The rest is the tint, the hue
 * the water lends the floor. Three anchors fix it:
 *
 * - at `clarity`, rho = 1 whatever the curve, so the floor's light is
 *   exactly `waterShallow`: "seen at the shallow colour";
 * - at `visibleDepth` the clearest channel (tint 0) passes
 *   `VISIBLE_SHARE`: `grey * rho_v = ln(1 / share)`, so
 *   `p = ln(ln(1 / share) / grey) / ln(visibleDepth / clarity)`;
 * - `depthCurve` 1 makes `tau_c = a_c * rho`: one exponential per channel
 *   in rho, today's mix. With p = 1 too (`visibleDepth` at the depth where
 *   `waterShallow`'s clearest channel, Beer–Lambert, passes the share), it
 *   is exactly `exp(-a_c / clarity * z)`, the water before these terms.
 *
 * `depthCurve` above 1 holds the hue back above `clarity` and drives it
 * past: the tint changes fastest around `clarity`, so levels there step
 * in colour, and the deep's hue saturates while its brightness still
 * falls by `p`. The composite applies this to the thickness along the
 * view ray, which is the depth only looking straight down.
 */
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
  // At `clarity` itself the share is fixed by the colour: no power moves it.
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

/**
 * Sun and sky for a sun direction: a low sun golden by `sunWarmth` over
 * the cool sky, so shadows go blue and lit faces warm; toward noon both go
 * neutral. The key is scaled so a flat, open, sunlit face keeps the same
 * brightness as the sun climbs or sinks.
 */
function sunlight(
  sun: Rgb,
  settings: Pick<IslandsSettings, "skyColor" | "sunStrength" | "sunWarmth">
) {
  const height = clamp01(sun[1]);
  // 0 below about 26°, 1 above about 63°.
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

/**
 * The look for a set of settings on a chart whose banks stand on
 * `banks.levels` levels (banks.ts `banksOf`), which the depths follow from.
 * `time` is the wave clock; `water: false` leaves the shaded view without
 * its water (the bench's terrain alone).
 */
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

/**
 * The open floor's colour: lit as the terrain lights flat, open ground
 * (normal up, no occlusion, in the sun), so the water past the mesh
 * matches the floor at its edge.
 */
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

/** Whether a look animates: waves on, in a view that shows them. */
export const animates = (look: Look): boolean =>
  look.water && look.waveStrength > 0;
