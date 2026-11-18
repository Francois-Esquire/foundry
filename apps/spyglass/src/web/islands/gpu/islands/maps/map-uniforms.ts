import type { Chart, Point } from "../../../data/chart";
import { banksOf } from "../sea/banks";
import {
  breakDepth,
  floorPaintOf,
  seaDepthsOf,
  surfSpeed,
  swellHeading,
  taperOf,
} from "../sea/sea-params";
import { FIELD_EDGE, HEDGE } from "../world/zoning";
import type { PackedBanks } from "./map-data";
import type { MapParams } from "./map-params";
import { clamp01, landUniform, sunDirection } from "./uniforms";

export const MAP_MARGIN = 0.05;

export interface MapFrame {
  readonly origin: Point;
  readonly resolution: number;
  readonly texel: number;
}

export const sideOf = (mf: MapFrame): number => mf.texel * mf.resolution;

const centreOf = (mf: MapFrame): Point => {
  const half = sideOf(mf) / 2;
  return [mf.origin[0] + half, mf.origin[1] + half];
};

export function mapFrame(chart: Chart, resolution: number): MapFrame {
  const { width, height } = chart.extent;
  const side = Math.max(width, height) * (1 + 2 * MAP_MARGIN);
  return {
    origin: [-side / 2, -side / 2],
    resolution,
    texel: side / resolution,
  };
}

export function mipLevelCount(resolution: number): number {
  const levels = Math.log2(resolution) + 1;
  if (!Number.isInteger(levels)) {
    throw new Error(`A map's side must be a power of two, not ${resolution}`);
  }
  return levels;
}

const LIGHT_REACH_SHARE = 1 / 1024;

export const frameUniform = (mf: MapFrame) => ({
  origin: mf.origin,
  resolution: mf.resolution,
  texel: mf.texel,
});

const MIN_RISER_TEXELS = 2.5;

const MAX_DEEP_RINGS = 32;
const MAX_UNDULATION = 0.45;
const wayOf = (degrees: number): [number, number] => {
  const a = (degrees * Math.PI) / 180;
  return [Math.cos(a), Math.sin(a)];
};

export const SEABED_RESOLUTION = 1024;

const SEABED_BAND = 0.5;

const seascapeCalm = (params: MapParams): number =>
  Math.max(params.bankSpread, 0) +
  Math.max(params.bankMargin, 0) +
  Math.max(params.shelfWidth, 0);

const seascapeUniform = (params: MapParams, mf: MapFrame) => ({
  basins: Math.max(params.seascapeBasins, 0),
  calm: seascapeCalm(params),
  canyons: Math.max(params.seascapeCanyons, 0),
  descent: Math.max(params.seascapeDescent, 0),
  faults: Math.max(params.seascapeFaults, 0),
  hills: Math.max(params.seascapeHills, 0),
  pits: clamp01(params.seascapePits),
  radius: sideOf(mf) / (2 * (1 + 2 * MAP_MARGIN)),
  rise: Math.max(params.shelfWidth, 0),
  scale: Math.max(params.seascapeScale, 1),
  seed: Math.max(Math.round(params.seascapeSeed), 0),
  sills: clamp01(params.seascapeSills),
  step: Math.max(params.seascapeStep, 1),
  veer: clamp01(params.seascapeVeer),
});

export function seabedFrame(mf: MapFrame, params: MapParams): MapFrame {
  const reach = sideOf(mf) * Math.max(params.seascapeReach, 1);
  const centre = centreOf(mf);
  return {
    origin: [centre[0] - reach / 2, centre[1] - reach / 2],
    resolution: SEABED_RESOLUTION,
    texel: reach / SEABED_RESOLUTION,
  };
}

const seabedPast = (grid: MapFrame, seabed: MapFrame): number =>
  Math.max((sideOf(seabed) - sideOf(grid)) / 2, 0);

export function openFloorDepth(
  sea: {
    readonly descent: number;
    readonly floorDepth: number;
    readonly step: number;
  },
  grid: MapFrame,
  seabed: MapFrame
): number {
  const descent = Math.max(sea.descent, 0);
  const depth = sea.floorDepth + descent * seabedPast(grid, seabed);
  if (sea.step <= 1 || sea.floorDepth <= 0) {
    return depth;
  }
  const steps = Math.log(depth / sea.floorDepth) / Math.log(sea.step);
  return sea.floorDepth * sea.step ** Math.ceil(steps - 1e-9);
}

export function seabedUniforms(
  params: MapParams,
  mf: MapFrame,
  levels: number
) {
  const seabed = seabedFrame(mf, params);
  const { bed, platform, banks, seascape } = heightUniforms(params, mf, {
    bankCount: 0,
    islandCount: 0,
    levels,
  });
  return {
    band: SEABED_BAND * seabedPast(mf, seabed),
    banks,
    bed,
    frame: frameUniform(seabed),
    grid: frameUniform(mf),
    openDepth: openFloorDepth(
      { ...seascape, floorDepth: bed.floorDepth },
      mf,
      seabed
    ),
    platform,
    seascape,
  };
}

export function heightUniforms(
  params: MapParams,
  mf: MapFrame,
  banks?: Pick<PackedBanks, "bankCount" | "islandCount" | "levels">
) {
  const levels = banks?.levels ?? 0;
  const depths = seaDepthsOf(params, levels);
  const minRiser = MIN_RISER_TEXELS * mf.texel;
  return {
    banks: {
      bankCount: banks?.bankCount ?? 0,
      bottomReach: Math.max(params.bankBottomReach, 0),
      bridge: Math.max(params.bankBridge, 0),
      hull: Math.max(params.bankHull, 0),
      islandCount: banks?.islandCount ?? 0,
      levels,
      lift: clamp01(params.bankLift),
      liftTread: Math.max(params.bankLiftTread, 0),
      minRiser,
      moat: Math.max(params.bankMoat, 0),
      moatAmount: clamp01(params.bankMoatAmount),
      run: params.bankRun > 0 ? Math.max(params.bankRun, minRiser) : 0,
      slope: Math.max(params.bankSlope, 0),
      spread: Math.max(params.bankSpread, 0),
      step: Math.max(params.bankStep, 0),
      taper: taperOf(params),
      top: depths.top,
      topReach: Math.min(Math.max(params.bankTopReach, 0), 1),
      undulation: Math.min(Math.max(params.bankUndulation, 0), MAX_UNDULATION),
      undulationBend: Math.max(params.bankUndulationBend, 0),
      undulationLength: Math.max(params.bankUndulationLength, 0),
      undulationShift: params.bankUndulationShift,
      undulationSteps: Math.max(Math.round(params.bankUndulationSteps), 0),
      undulationWay: wayOf(params.bankUndulationAngle),
      wander: Math.max(params.bankWander, 0),
    },
    beach: {
      cliff: Math.max(params.shoreCliffWidth, minRiser),
      cliffDepth: Math.max(params.shoreCliffDepth, params.shoreSandDepth, 0),
      cove: Math.max(params.shoreCove, 0),
      coveDepth: Math.max(params.shoreCoveDepth, 0),
      height: Math.max(params.shoreSandHeight, 0),
      sandDepth: Math.max(params.shoreSandDepth, 0),
      smallSand: Math.max(params.shoreSmallSand, 0),
      smallSize: Math.max(params.shoreSmallSize, 1),
      width: Math.max(params.bankBeach, mf.texel),
    },
    bed: {
      floorDepth: depths.floor,
      slopeWidth: Math.max(params.shelfWidth, 0),
      texel: mf.texel,
    },
    coastColumns: 1,
    frame: frameUniform(mf),
    land: landUniform(params),
    platform: {
      base: depths.platform,
      deepRings: Math.min(
        Math.max(Math.round(params.bankDeepRings), 0),
        MAX_DEEP_RINGS
      ),
      margin: Math.max(params.bankMargin, 0),
      merge: Math.max(params.bankMerge, 1e-3),
      ragged: Math.max(params.bankRagged, 0),
      scarp: clamp01(params.bankScarp),
    },
    rimSmoothing: params.rimSmoothing,
    rowStart: 0,
    seascape: seascapeUniform(params, mf),
  };
}

export function paintUniforms(params: MapParams, mf: MapFrame, chart: Chart) {
  const { levels } = banksOf(chart);
  return {
    cliffDepth: Math.max(params.shoreCliffDepth, params.shoreSandDepth, 0),
    floor: floorPaintOf(params, levels),
    frame: frameUniform(mf),
    islandCount: chart.islands.length,
    probe: Math.max(params.bankBeach, mf.texel),
    sandDepth: Math.max(params.shoreSandDepth, 0),
  };
}

export function flowUniforms(params: MapParams, mf: MapFrame) {
  return {
    frame: frameUniform(mf),
    reach: mf.texel * mf.resolution * LIGHT_REACH_SHARE,
    swell: {
      breakDepth: breakDepth(params.swellHeight),
      drift: params.sedimentDrift,
      heading: swellHeading(params.swellAzimuth),
      length: params.swellLength,
      speed: surfSpeed(params.swellHeight),
    },
  };
}

export function lightUniforms(params: MapParams, mf: MapFrame) {
  return {
    blur: Math.max(params.shadowBlur, 0),
    ceiling:
      Math.max(params.plateHeight, 0) +
      Math.max(params.lipHeight, 0) +
      Math.max(params.crownHeight, 0),
    frame: frameUniform(mf),
    reach: mf.texel * mf.resolution * LIGHT_REACH_SHARE,
    sun: sunDirection(params.sunAzimuth, params.sunElevation),
  };
}

export function filesUniforms(params: MapParams, mf: MapFrame) {
  return {
    frame: frameUniform(mf),
    radius: Math.max(params.fileRadius, mf.texel),
  };
}

const RESERVE_EASE = 1;
const ZONE_FEATHER = 2;

export function zoningUniforms(mf: MapFrame) {
  const ease = Math.max(RESERVE_EASE, mf.texel);
  const feather = Math.max(ZONE_FEATHER, mf.texel);
  const ring = Math.max(
    ...[HEDGE, FIELD_EDGE].map((r) => r.offset + Math.max(r.half, mf.texel))
  );
  return {
    ease: RESERVE_EASE,
    feather: ZONE_FEATHER,
    frame: frameUniform(mf),
    reach: Math.max(ease, feather / 2, ring) + mf.texel,
  };
}
