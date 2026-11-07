/**
 * The town's kit of parts (TOWNS.md "How it's built"): every building,
 * stand and mast is a few instanced parts of four shapes, drawn by
 * shaders/world/town.wgsl one draw a shape. A box is four walls and a top; a
 * roof is a gabled or hipped prism over a footprint; a round is a round
 * wall under a cone; an open part is a box drawn with holes in it, for
 * balconies, outside stairs, nets and climbing frames, in a draw of its
 * own so the solid parts keep their early depth test.
 *
 * Everything is at one human scale, the same for every building: a door is
 * `DOOR_HEIGHT`, a storey `STOREY`, and the doors and windows are painted
 * on in the fragment at a fixed size. A building grows by floors and by
 * parts, never by scaling.
 *
 * A part stands on a site: its lot, or a site of its own for a part far
 * from its lot's middle (a stand round a pitch, a floodlight). Each site's
 * ground is found once on the GPU when the maps or the plan change
 * (shaders/world/town-floors.wgsl), so the frame samples no ground for a body.
 */
import type { Point } from "../../../data/chart";

/** Chart units, about four metres a unit: the human scale (shaders/world/town.wgsl, the same names). */
export const DOOR_HEIGHT = 0.5;
export const STOREY = 0.75;

const HASH_SPAN = 1000;

/** 0–1 from a place: a building's own shade and its choices. */
export const variantOf = (at: Point): number =>
  (Math.abs(Math.sin(at[0] * 12.9898 + at[1] * 78.233)) * HASH_SPAN) % 1;

/** The shapes, each its own draw (shaders/world/town.wgsl `BOX`, `ROOF`, `ROUND`, `OPEN`). */
export const TOWN_SHAPES = ["box", "roof", "round", "open"] as const;
export type TownShape = (typeof TOWN_SHAPES)[number];

/** What a part is made of (shaders/world/town.wgsl, the same names). */
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

/** How an open part is cut (shaders/world/town.wgsl `BALCONY`, ...). */
const OPEN_STYLES = {
  balcony: 0,
  fence: 4,
  frame: 3,
  net: 2,
  stair: 1,
} as const;
type OpenStyle = keyof typeof OPEN_STYLES;

/** A box's faces that have a door at their middle: across +x, −x, +z, −z. */
export const FACES = { east: 1, north: 4, south: 8, west: 2 } as const;

/**
 * How a wall's windows are cut (shaders/world/town.wgsl `windowOf`): a house's
 * ordinary sashes, wide sliding windows, narrow upright ones, a public
 * building's continuous ribbon, or a few small ones in a mostly blind wall.
 */
const WINDOW_STYLES = {
  narrow: 2,
  ribbon: 3,
  sash: 0,
  sliding: 1,
  sparse: 4,
} as const;
export type WindowStyle = keyof typeof WINDOW_STYLES;

/**
 * Each material's colour when a part names none, standard RGB. The
 * buildings' walls and roofs choose theirs from the palette
 * (structures-palette.ts); these are the fixed things: glass, steel,
 * concrete, hedges, lacquer.
 */
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

/** A part in its lot's frame: local +z toward the street. */
export interface TownPart {
  /** Its middle in the lot's frame. */
  readonly at: Point;
  /** Bands of `trim` round its wall. */
  readonly banded: boolean;
  /** Height of its bottom above its site's ground; 0 stands it on the floor. */
  readonly base: number;
  /** A wall whose +z face is open on its ground storey: a boathouse's slip. */
  readonly bay: boolean;
  /** Its colour, standard RGB hex; null takes its material's (`MATERIAL_COLORS`). */
  readonly color: string | null;
  /** A roof whose slopes sag and whose eaves turn up, as a shrine's. */
  readonly curved: boolean;
  /** Doors evenly along its +z face: on the ground storey, or every storey with `rowEvery`. */
  readonly doorRow: number;
  /** `FACES` sums: a door at the middle of each, on the ground storey. */
  readonly doors: number;
  /** A wall under a roof's eaves: darkened under them. */
  readonly eaved: boolean;
  /** Half its footprint across (local x) and along (local z); a round's radius is `half[0]`. */
  readonly half: readonly [number, number];
  readonly hipped: boolean;
  readonly material: TownMaterial;
  /** A roof's and a round's eaves past their walls. */
  readonly overhang: number;
  /** Stands on a site of its own, the lowest ground under its footprint. */
  readonly ownSite: boolean;
  /** A flat top with a parapet's rim round it. */
  readonly parapet: boolean;
  /** For an open part, an index; for seats, how many blocks the stand is marked in. */
  readonly places: number;
  /** A roof's ridge over its eaves; a round's cone over its wall. */
  readonly rise: number;
  readonly rowEvery: boolean;
  /** Whether it casts a shadow on the ground: one caster a building. */
  readonly shades: boolean;
  readonly shape: TownShape;
  /** A roof whose ridge runs along its −x edge: one slope, a lean-to or a canopy. */
  readonly shed: boolean;
  /** A glazed, lit front along its +z face's ground storey. */
  readonly shopfront: boolean;
  readonly style: OpenStyle;
  /** A second material: a gable's ends, a round's wall, a band of colour. */
  readonly trim: TownMaterial;
  /** Its trim's colour, the same way. */
  readonly trimColor: string | null;
  /** Radians, its local z turned from the lot's toward −x. */
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

/** Turns `p` the way the shader turns a part: local z toward −x (world.ts). */
export const turned = (p: Point, turn: number): Point => [
  Math.cos(turn) * p[0] - Math.sin(turn) * p[1],
  Math.sin(turn) * p[0] + Math.cos(turn) * p[1],
];

/** A part placed on the chart: its lot's middle and turn applied, and its site. */
export interface PlacedPart {
  readonly at: Point;
  readonly part: TownPart;
  readonly site: number;
  readonly turn: number;
  /** 0–1, its building's own, for small differences in colour. */
  readonly variant: number;
}

/** A site whose ground the floors pass finds: a lot, or a part's own. */
export interface Site {
  readonly at: Point;
  readonly half: readonly [number, number];
  readonly turn: number;
}

/** vec4f a part (shaders/world/town.wgsl `Part`) and a site (shaders/world/town-floors.wgsl `Site`). */
const PART_VEC4S = 5;
const SITE_VEC4S = 2;
const FLOATS_PER_VEC4 = 4;

// Distinct bits, so their sum is their union (shaders/world/town.wgsl, the same names).
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
/** The shape's index, packed above the flags (shaders/world/town.wgsl `SHAPE_SHIFT`). */
const SHAPE_UNIT = 4096;
/** The door row's count, packed above the faces' bits (shaders/world/town.wgsl `ROW_UNIT`). */
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

/**
 * A standard RGB hex colour as one float: red × 65536 + green × 256 +
 * blue, exact below 2²⁴ (shaders/world/town.wgsl `colorOf` takes it apart).
 */
const packColor = (hex: string): number =>
  Number.parseInt(hex.slice(1), HEX_RADIX);

/** An open part's style, or a roof's or round's overhang, in the fourth vec4f. */
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
  /** Each shape's run of instances in `data`. */
  readonly runs: Readonly<Record<TownShape, { first: number; count: number }>>;
  readonly shadeCount: number;
  /** The parts that cast a shadow, packed the same way. */
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

/** The parts as the shader reads them, sorted into a run for each shape. */
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
