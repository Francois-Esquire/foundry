import type { Point } from "../../../data/chart";
import type { TownMaterial } from "./town-parts";
import { variantOf } from "./town-parts";

type Range = readonly [string, string];

interface Share<T> {
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

const WALL_SHARES: readonly Share<WallTone>[] = [
  { below: 0.4, value: "offWhite" },
  { below: 0.7, value: "beige" },
  { below: 0.9, value: "paleGrey" },
  { below: 0.95, value: "timber" },
  { below: 1, value: "siding" },
];

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

const ROOF_SHARES: readonly Share<RoofTone>[] = [
  { below: 0.6, value: "grey" },
  { below: 0.72, value: "blueGrey" },
  { below: 0.8, value: "slate" },
  { below: 0.95, value: "green" },
  { below: 1, value: "brown" },
];

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

const SALT_STEP: Point = [17.31, -4.13];

export const pickOf = (at: Point, salt: number): number =>
  variantOf([at[0] + SALT_STEP[0] * salt, at[1] + SALT_STEP[1] * salt * 1.37]);

export interface Paint {
  readonly color: string;
  readonly material: TownMaterial;
}

export function wallPaint(
  pick: number,
  shade: number
): Paint & { tone: WallTone } {
  const tone = chosen(WALL_SHARES, pick);
  const [a, b] = WALL_RANGES[tone];
  return { color: mixHex(a, b, shade), material: WALL_MATERIALS[tone], tone };
}

export function lightWallPaint(pick: number, shade: number): Paint {
  return wallPaint(pick * 0.9, shade);
}

export function roofPaint(
  pick: number,
  shade: number
): Paint & { tone: RoofTone } {
  const tone = chosen(ROOF_SHARES, pick);
  const [a, b] = ROOF_RANGES[tone];
  return { color: mixHex(a, b, shade), material: ROOF_MATERIALS[tone], tone };
}

export const COLORS = {
  aluminium: "#b6b8b6",
  block: "#b8b4aa",
  clearRoof: "#c9cdc9",
  copper: "#5d8577",
  darkTimber: "#4e3c2e",
  fence: "#4d5b52",
  hedge: "#3f5c33",
  lighthouse: "#f2f0ea",
  lighthouseBand: "#a8322a",
  pole: "#a8a69e",
  torii: "#26221f",
  unit: "#dedcd4",
  vermilion: "#b8432c",
} as const;
