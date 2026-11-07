/**
 * The structures' palette (REFERENCES.md "Art rules", rules 1 and 2): what
 * colour a building's walls and roof are, chosen once from its place so a
 * changed file repaints only its own building. Walls are off-white, beige
 * or pale grey, and about one building in ten breaks the rule with dark
 * timber or metal siding. Roofs are mostly grey tile, then blue-grey or
 * slate, then green painted metal, and the odd rust brown; nothing orange
 * or loud. Colours are standard RGB hex, picked inside each range.
 */
import type { Point } from "../../../data/chart";
import type { TownMaterial } from "./town-parts";
import { variantOf } from "./town-parts";

/** A range of colour: anywhere between its two ends. */
type Range = readonly [string, string];

interface Share<T> {
  /** The running share below which this choice is taken. */
  readonly below: number;
  readonly value: T;
}

const WALL_RANGES = {
  beige: ["#d8ccb2", "#e0d6c0"],
  offWhite: ["#e8e4da", "#f2efe8"],
  paleGrey: ["#c4c4be", "#d2d2cc"],
  siding: ["#8e969c", "#a4aaae"],
  timber: ["#5a4636", "#6e5644"],
} as const satisfies Record<string, Range>;
export type WallTone = keyof typeof WALL_RANGES;

/** Shares of walls: forty, thirty, twenty, then one in ten breaks the rule. */
const WALL_SHARES: readonly Share<WallTone>[] = [
  { below: 0.4, value: "offWhite" },
  { below: 0.7, value: "beige" },
  { below: 0.9, value: "paleGrey" },
  { below: 0.95, value: "timber" },
  { below: 1, value: "siding" },
];

/** What a wall of each tone is made of: its pattern in the shader. */
const WALL_MATERIALS: Readonly<Record<WallTone, TownMaterial>> = {
  beige: "siding",
  offWhite: "plaster",
  paleGrey: "siding",
  siding: "metal",
  timber: "timber",
};

const ROOF_RANGES = {
  blueGrey: ["#505b67", "#616c78"],
  brown: ["#664a40", "#6e4e44"],
  green: ["#5f8a7a", "#74998a"],
  grey: ["#5c5f63", "#7b7e82"],
  slate: ["#3a3d42", "#41444a"],
} as const satisfies Record<string, Range>;
export type RoofTone = keyof typeof ROOF_RANGES;

/** Sixty percent grey, twenty blue-grey or slate, fifteen green metal, five brown. */
const ROOF_SHARES: readonly Share<RoofTone>[] = [
  { below: 0.6, value: "grey" },
  { below: 0.72, value: "blueGrey" },
  { below: 0.8, value: "slate" },
  { below: 0.95, value: "green" },
  { below: 1, value: "brown" },
];

/** Grey and slate are tile; the painted colours are standing-seam metal. */
const ROOF_MATERIALS: Readonly<Record<RoofTone, TownMaterial>> = {
  blueGrey: "tile",
  brown: "seam",
  green: "seam",
  grey: "tile",
  slate: "tile",
};

const HEX_RADIX = 16;
const BYTE = 255;
const CHANNEL_SHIFT = 256;

/** Between two hex colours, `t` of the way, as hex. */
function mixHex(a: string, b: string, t: number): string {
  const ca = Number.parseInt(a.slice(1), HEX_RADIX);
  const cb = Number.parseInt(b.slice(1), HEX_RADIX);
  let out = 0;
  let unit = 1;
  let restA = ca;
  let restB = cb;
  for (let k = 0; k < 3; k += 1) {
    const x = restA % CHANNEL_SHIFT;
    const y = restB % CHANNEL_SHIFT;
    restA = Math.floor(restA / CHANNEL_SHIFT);
    restB = Math.floor(restB / CHANNEL_SHIFT);
    const channel = Math.min(Math.max(Math.round(x + (y - x) * t), 0), BYTE);
    out += channel * unit;
    unit *= CHANNEL_SHIFT;
  }
  return `#${out.toString(HEX_RADIX).padStart(6, "0")}`;
}

const chosen = <T>(shares: readonly Share<T>[], pick: number): T => {
  const last = shares.at(-1) as Share<T>;
  return (shares.find((s) => pick < s.below) ?? last).value;
};

/** Offsets that make a place's independent choices, one a salt. */
const SALT_STEP: Point = [17.31, -4.13];

/**
 * 0–1 from a place and a salt: a building's choices, each independent of
 * the others, the same every time the plan is made.
 */
export const pickOf = (at: Point, salt: number): number =>
  variantOf([at[0] + SALT_STEP[0] * salt, at[1] + SALT_STEP[1] * salt * 1.37]);

export interface Paint {
  readonly color: string;
  readonly material: TownMaterial;
}

/** A wall's colour and pattern: `pick` chooses the tone, `shade` the colour in its range. */
export function wallPaint(
  pick: number,
  shade: number
): Paint & { tone: WallTone } {
  const tone = chosen(WALL_SHARES, pick);
  const [a, b] = WALL_RANGES[tone];
  return { color: mixHex(a, b, shade), material: WALL_MATERIALS[tone], tone };
}

/** A wall from the light tones only, for buildings that never break the rule. */
export function lightWallPaint(pick: number, shade: number): Paint {
  return wallPaint(pick * 0.9, shade);
}

/** A roof's colour and pattern. */
export function roofPaint(
  pick: number,
  shade: number
): Paint & { tone: RoofTone } {
  const tone = chosen(ROOF_SHARES, pick);
  const [a, b] = ROOF_RANGES[tone];
  return { color: mixHex(a, b, shade), material: ROOF_MATERIALS[tone], tone };
}

/** Fixed colours the buildings share, standard RGB. */
export const COLORS = {
  /** Aluminium: window frames, rails, a car port's posts. */
  aluminium: "#b6b8b6",
  /** Concrete block garden walls. */
  block: "#b8b4aa",
  /** A car port's or a canopy's clear roof. */
  clearRoof: "#c9cdc9",
  /** A shrine's verdigris copper roof. */
  copper: "#5d8577",
  /** The dark timber of a boathouse, a shrine. */
  darkTimber: "#4e3c2e",
  /** A fence's dark green mesh. */
  fence: "#4d5b52",
  /** A hedge's green. */
  hedge: "#3f5c33",
  /** A lighthouse's white and its band. */
  lighthouse: "#f2f0ea",
  lighthouseBand: "#a8322a",
  /** A pole's concrete. */
  pole: "#a8a69e",
  /** A torii's black cap. */
  torii: "#26221f",
  /** An air conditioner's outdoor unit. */
  unit: "#dedcd4",
  /** A torii's vermilion. */
  vermilion: "#b8432c",
} as const;
