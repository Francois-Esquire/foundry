import type { Point } from "../../../data/chart";

export const DOOR_HEIGHT = 0.5;
export const STOREY = 0.75;

const HASH_SPAN = 1000;

export const variantOf = (at: Point): number =>
  (Math.abs(Math.sin(at[0] * 12.9898 + at[1] * 78.233)) * HASH_SPAN) % 1;

export const TOWN_SHAPES = ["box", "roof", "round", "open"] as const;
export type TownShape = (typeof TOWN_SHAPES)[number];

const TOWN_MATERIALS = {
  beige: 1,
  block: 17,
  blueTile: 6,
  clock: 22,
  concrete: 18,
  frame: 25,
  glass: 8,
  grey: 2,
  hedge: 13,
  lacquer: 24,
  lamp: 16,
  membrane: 7,
  metal: 4,
  net: 19,
  panel: 12,
  plaster: 0,
  red: 11,
  seam: 21,
  seats: 15,
  siding: 20,
  sign: 9,
  steel: 14,
  tile: 5,
  timber: 3,
  vending: 23,
  white: 10,
} as const;
export type TownMaterial = keyof typeof TOWN_MATERIALS;

const OPEN_STYLES = {
  balcony: 0,
  fence: 4,
  frame: 3,
  net: 2,
  stair: 1,
} as const;
type OpenStyle = keyof typeof OPEN_STYLES;

export const FACES = { east: 1, north: 4, south: 8, west: 2 } as const;

const WINDOW_STYLES = {
  narrow: 2,
  ribbon: 3,
  sash: 0,
  sliding: 1,
  sparse: 4,
} as const;
export type WindowStyle = keyof typeof WINDOW_STYLES;

const MATERIAL_COLORS: Readonly<Record<TownMaterial, string>> = {
  beige: "#dcd1b9",
  block: "#b8b4aa",
  blueTile: "#55636f",
  clock: "#f4f2ea",
  concrete: "#a8a69e",
  frame: "#3a3d42",
  glass: "#1e262c",
  grey: "#cbcbc5",
  hedge: "#3b5a32",
  lacquer: "#b4402e",
  lamp: "#fff4dc",
  membrane: "#6e6f6c",
  metal: "#999fa4",
  net: "#2c3a33",
  panel: "#d9dad6",
  plaster: "#ece8df",
  red: "#a8322a",
  seam: "#6a6e74",
  seats: "#2f5b8e",
  siding: "#e2ded4",
  sign: "#f2f2ee",
  steel: "#55585c",
  tile: "#6a6e74",
  timber: "#644e3d",
  vending: "#c63a32",
  white: "#efefea",
};

export interface TownPart {
  readonly at: Point;
  readonly banded: boolean;
  readonly base: number;
  readonly bay: boolean;
  readonly color: string | null;
  readonly curved: boolean;
  readonly doorRow: number;
  readonly doors: number;
  readonly eaved: boolean;
  readonly half: readonly [number, number];
  readonly hipped: boolean;
  readonly material: TownMaterial;
  readonly overhang: number;
  readonly ownSite: boolean;
  readonly parapet: boolean;
  readonly places: number;
  readonly rise: number;
  readonly rowEvery: boolean;
  readonly shades: boolean;
  readonly shape: TownShape;
  readonly shed: boolean;
  readonly shopfront: boolean;
  readonly style: OpenStyle;
  readonly trim: TownMaterial;
  readonly trimColor: string | null;
  readonly turn: number;
  readonly wall: number;
  readonly windowStyle: WindowStyle;
  readonly windows: boolean;
}

const PART_DEFAULTS = {
  at: [0, 0],
  banded: false,
  base: 0,
  bay: false,
  color: null,
  curved: false,
  doorRow: 0,
  doors: 0,
  eaved: false,
  hipped: false,
  overhang: 0.15,
  ownSite: false,
  parapet: false,
  places: 0,
  rise: 0,
  rowEvery: false,
  shades: false,
  shed: false,
  shopfront: false,
  style: "frame",
  trim: "plaster",
  trimColor: null,
  turn: 0,
  wall: 0,
  windowStyle: "sash",
  windows: false,
} as const satisfies Partial<TownPart>;

export const townPart = (
  fields: Pick<TownPart, "shape" | "half" | "material"> & Partial<TownPart>
): TownPart => ({ ...PART_DEFAULTS, ...fields });

export const turned = (p: Point, turn: number): Point => [
  Math.cos(turn) * p[0] - Math.sin(turn) * p[1],
  Math.sin(turn) * p[0] + Math.cos(turn) * p[1],
];

export interface PlacedPart {
  readonly at: Point;
  readonly part: TownPart;
  readonly site: number;
  readonly turn: number;
  readonly variant: number;
}

export interface Site {
  readonly at: Point;
  readonly half: readonly [number, number];
  readonly turn: number;
}

const PART_VEC4S = 5;
const SITE_VEC4S = 2;
const FLOATS_PER_VEC4 = 4;

const FLAG_SHADES = 1;
const FLAG_WINDOWS = 2;
const FLAG_HIPPED = 4;
const FLAG_PARAPET = 8;
const FLAG_SHOPFRONT = 16;
const FLAG_BANDED = 32;
const FLAG_ROW_EVERY = 64;
const FLAG_SHED = 128;
const FLAG_CURVED = 256;
const FLAG_EAVED = 512;
const FLAG_BAY = 1024;
const SHAPE_UNIT = 4096;
const ROW_UNIT = 16;

const flagsOf = (p: TownPart): number =>
  (p.shades ? FLAG_SHADES : 0) +
  (p.windows ? FLAG_WINDOWS : 0) +
  (p.hipped ? FLAG_HIPPED : 0) +
  (p.parapet ? FLAG_PARAPET : 0) +
  (p.shopfront ? FLAG_SHOPFRONT : 0) +
  (p.banded ? FLAG_BANDED : 0) +
  (p.rowEvery ? FLAG_ROW_EVERY : 0) +
  (p.shed ? FLAG_SHED : 0) +
  (p.curved ? FLAG_CURVED : 0) +
  (p.eaved ? FLAG_EAVED : 0) +
  (p.bay ? FLAG_BAY : 0) +
  TOWN_SHAPES.indexOf(p.shape) * SHAPE_UNIT;

const HEX_RADIX = 16;

const packColor = (hex: string): number =>
  Number.parseInt(hex.slice(1), HEX_RADIX);

const styleOf = (p: TownPart): number =>
  p.shape === "open" ? OPEN_STYLES[p.style] : p.overhang;

function packInto(parts: readonly PlacedPart[]): Float32Array<ArrayBuffer> {
  const stride = PART_VEC4S * FLOATS_PER_VEC4;
  const packed = new Float32Array(Math.max(parts.length, 1) * stride);
  for (const [i, placed] of parts.entries()) {
    const p = placed.part;
    packed.set(
      [
        placed.at[0],
        placed.at[1],
        placed.turn,
        placed.variant,
        p.half[0],
        p.half[1],
        p.base,
        p.wall,
        placed.site,
        p.rise,
        TOWN_MATERIALS[p.material],
        TOWN_MATERIALS[p.trim],
        p.doors + p.doorRow * ROW_UNIT,
        flagsOf(p),
        styleOf(p),
        p.places,
        packColor(p.color ?? MATERIAL_COLORS[p.material]),
        packColor(p.trimColor ?? MATERIAL_COLORS[p.trim]),
        WINDOW_STYLES[p.windowStyle],
        0,
      ],
      i * stride
    );
  }
  return packed;
}

export interface PackedTown {
  readonly data: Float32Array<ArrayBuffer>;
  readonly runs: Readonly<Record<TownShape, { first: number; count: number }>>;
  readonly shadeCount: number;
  readonly shades: Float32Array<ArrayBuffer>;
  readonly siteCount: number;
  readonly sites: Float32Array<ArrayBuffer>;
}

function packSites(sites: readonly Site[]): Float32Array<ArrayBuffer> {
  const stride = SITE_VEC4S * FLOATS_PER_VEC4;
  const packed = new Float32Array(Math.max(sites.length, 1) * stride);
  for (const [i, s] of sites.entries()) {
    packed.set(
      [s.at[0], s.at[1], s.turn, 0, s.half[0], s.half[1], 0, 0],
      i * stride
    );
  }
  return packed;
}

export function packTown(
  parts: readonly PlacedPart[],
  sites: readonly Site[]
): PackedTown {
  const byShape = TOWN_SHAPES.map((shape) =>
    parts.filter((p) => p.part.shape === shape)
  );
  let first = 0;
  const runs = {} as Record<TownShape, { first: number; count: number }>;
  for (const [i, shape] of TOWN_SHAPES.entries()) {
    const count = byShape[i]?.length ?? 0;
    runs[shape] = { count, first };
    first += count;
  }
  const shading = parts.filter((p) => p.part.shades);
  return {
    data: packInto(byShape.flat()),
    runs,
    shadeCount: shading.length,
    shades: packInto(shading),
    siteCount: sites.length,
    sites: packSites(sites),
  };
}
