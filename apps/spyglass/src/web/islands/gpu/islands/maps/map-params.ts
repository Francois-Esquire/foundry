import {
  DEFAULT_SEA_PARAMS,
  MAP_OF_SEA_MAP_PARAM,
  type SeaMapParams,
  seaMapParamsOf,
} from "../sea/sea-params";

export const MAP_NAMES = [
  "distance",
  "islands",
  "coverage",
  "coasts",
  "height",
  "rings",
  "footprints",
  "flow",
  "light",
  "shade",
  "paint",
  "files",
  "zoning",
  "seabed",
] as const;

export type MapName = (typeof MAP_NAMES)[number];

export const VIEWED_MAPS = [
  "distance",
  "islands",
  "coverage",
  "height",
  "rings",
  "flow",
  "light",
  "shade",
  "paint",
  "files",
  "zoning",
] as const satisfies readonly MapName[];

export type ViewedMap = (typeof VIEWED_MAPS)[number];

interface LandMapParams {
  crownHeight: number;
  crownWidth: number;
  feather: number;
  fileRadius: number;
  lipHeight: number;
  lipWidth: number;
  palette: "order" | "hash";
  plateHeight: number;
  resolution: 512 | 1024 | 2048;
  rimSmoothing: number;
  rimWidth: number;
  sunAzimuth: number;
  sunElevation: number;
  tileWorldSize: number;
}

export type MapParams = LandMapParams & SeaMapParams;

export const DEFAULT_MAP_PARAMS: MapParams = {
  ...seaMapParamsOf(DEFAULT_SEA_PARAMS),
  crownHeight: 4,
  crownWidth: 12,
  feather: 1,
  fileRadius: 1.5,
  lipHeight: 0.15,
  lipWidth: 2,
  palette: "order",
  plateHeight: 6,
  resolution: 2048,
  rimSmoothing: 2.5,
  rimWidth: 3,
  sunAzimuth: (7 * Math.PI) / 4,
  sunElevation: 0.6,
  tileWorldSize: 0,
};

export const MAP_OF_PARAM: Record<
  keyof MapParams,
  MapPassName | readonly MapPassName[]
> = {
  ...MAP_OF_SEA_MAP_PARAM,
  crownHeight: "height",
  crownWidth: "height",
  feather: "coverage",
  fileRadius: "files",
  lipHeight: "height",
  lipWidth: "height",
  palette: "paint",
  plateHeight: "height",
  resolution: ["distance", "files", "zoning"],
  rimSmoothing: "height",
  rimWidth: "height",
  sunAzimuth: "light",
  sunElevation: "light",
  tileWorldSize: ["distance", "coasts", "files", "zoning"],
};

export const MAP_PASSES = [
  { inputs: [], name: "distance", outputs: ["distance", "islands"] },
  { inputs: ["distance"], name: "coverage", outputs: ["coverage"] },
  { inputs: [], name: "coasts", outputs: ["coasts"] },
  {
    inputs: ["distance", "coasts"],
    name: "height",
    outputs: ["height", "rings", "footprints"],
  },
  { inputs: ["distance", "height"], name: "flow", outputs: ["flow"] },
  { inputs: ["height"], name: "light", outputs: ["light", "shade"] },
  {
    inputs: ["distance", "coverage", "height"],
    name: "paint",
    outputs: ["paint"],
  },
  { inputs: [], name: "files", outputs: ["files"] },
  { inputs: [], name: "zoning", outputs: ["zoning"] },
  { inputs: ["distance", "height"], name: "seabed", outputs: ["seabed"] },
] as const satisfies readonly {
  name: MapName;
  inputs: readonly MapName[];
  outputs: readonly MapName[];
}[];

export type MapPass = (typeof MAP_PASSES)[number];
export type MapPassName = MapPass["name"];

export function passesWithDependants(
  changed: Iterable<MapPassName>
): MapPass[] {
  const dirty = new Set(changed);
  return MAP_PASSES.filter((pass) => {
    if (pass.inputs.some((input) => dirty.has(input))) {
      dirty.add(pass.name);
    }
    return dirty.has(pass.name);
  });
}

const sameValue = (
  a: MapParams[keyof MapParams],
  b: MapParams[keyof MapParams]
): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
};

export function changedParams(
  before: Readonly<MapParams>,
  after: Readonly<MapParams>
): (keyof MapParams)[] {
  const keys = Object.keys(MAP_OF_PARAM) as (keyof MapParams)[];
  return keys.filter((key) => !sameValue(before[key], after[key]));
}
