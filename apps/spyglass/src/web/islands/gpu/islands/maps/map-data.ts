import type { Chart, ModuleKind } from "../../../data/chart";
import { banksOf } from "../sea/banks";
import { hexToLinear } from "../sea/sea-params";
import type { MapParams } from "./map-params";

const COAST_BYTES = 32;
const SEGMENT_FLOATS = 4;

export interface PackedCoasts {
  readonly coasts: ArrayBuffer;
  readonly islandCount: number;
  readonly segmentCount: number;
  readonly segments: Float32Array<ArrayBuffer>;
}

export function packCoasts(chart: Chart): PackedCoasts {
  const islandCount = chart.islands.length;
  let segmentCount = 0;
  for (const island of chart.islands) {
    for (const polygon of island.shape.coast) {
      segmentCount += polygon.outer.length;
      for (const hole of polygon.holes) {
        segmentCount += hole.length;
      }
    }
  }
  const coasts = new ArrayBuffer(Math.max(islandCount, 1) * COAST_BYTES);
  const words = new Uint32Array(coasts);
  const floats = new Float32Array(coasts);
  const segments = new Float32Array(Math.max(segmentCount, 1) * SEGMENT_FLOATS);
  let next = 0;
  for (const [i, island] of chart.islands.entries()) {
    const start = next;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const polygon of island.shape.coast) {
      for (const ring of [polygon.outer, ...polygon.holes]) {
        for (const [j, a] of ring.entries()) {
          const b = ring[(j + 1) % ring.length] ?? a;
          segments.set([a[0], a[1], b[0], b[1]], next * SEGMENT_FLOATS);
          next += 1;
          minX = Math.min(minX, a[0]);
          minY = Math.min(minY, a[1]);
          maxX = Math.max(maxX, a[0]);
          maxY = Math.max(maxY, a[1]);
        }
      }
    }
    const record = (i * COAST_BYTES) / 4;
    words[record] = start;
    words[record + 1] = next - start;
    floats.set([minX, minY, maxX, maxY], record + 4);
  }
  return { coasts, islandCount, segmentCount, segments };
}

export const MAX_BANK_ISLANDS = 64;
export const COASTS_RESOLUTION = 512;
const PIECE_BYTES = 32;
const BANK_ISLAND_BYTES = 12;
const BANK_BYTES = 24;

export interface PackedPieces {
  readonly islands: Uint32Array<ArrayBuffer>;
  readonly pieces: ArrayBuffer;
}

export function packPieces(chart: Chart): PackedPieces {
  const pieceCount = chart.islands.reduce(
    (n, island) => n + island.shape.coast.length,
    0
  );
  const islands = new Uint32Array(Math.max(chart.islands.length, 1) * 2);
  const pieces = new ArrayBuffer(Math.max(pieceCount, 1) * PIECE_BYTES);
  const words = new Uint32Array(pieces);
  const floats = new Float32Array(pieces);
  let segment = 0;
  let piece = 0;
  for (const [i, island] of chart.islands.entries()) {
    islands.set([piece, island.shape.coast.length], i * 2);
    for (const polygon of island.shape.coast) {
      const record = (piece * PIECE_BYTES) / 4;
      const box: [number, number, number, number] = [
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
      ];
      const start = segment;
      for (const ring of [polygon.outer, ...polygon.holes]) {
        for (const [x, y] of ring) {
          box[0] = Math.min(box[0], x);
          box[1] = Math.min(box[1], y);
          box[2] = Math.max(box[2], x);
          box[3] = Math.max(box[3], y);
        }
        segment += ring.length;
      }
      words[record] = start;
      words[record + 1] = segment - start;
      floats.set(box, record + 4);
      piece += 1;
    }
  }
  return { islands, pieces };
}

export interface PackedBanks {
  readonly bankCount: number;
  readonly banks: ArrayBuffer;
  readonly islandCount: number;
  readonly islands: ArrayBuffer;
  readonly levels: number;
  readonly members: Uint32Array<ArrayBuffer>;
}

export function packBanks(chart: Chart): PackedBanks {
  const { banks, levels, rings } = banksOf(chart);
  const islandCount = chart.islands.length;

  const islands = new ArrayBuffer(Math.max(islandCount, 1) * BANK_ISLAND_BYTES);
  const islandWords = new Uint32Array(islands);
  const islandFloats = new Float32Array(islands);
  for (const [i, island] of chart.islands.entries()) {
    islandWords[i * 3] = rings[i]?.length ?? 0;
    islandFloats[i * 3 + 1] = island.size;
    islandFloats[i * 3 + 2] = 1;
  }

  const order = banks
    .map((bank, b) => ({ b, bank }))
    .sort((x, y) => x.bank.level - y.bank.level || x.b - y.b);
  const bankBuffer = new ArrayBuffer(Math.max(banks.length, 1) * BANK_BYTES);
  const bankWords = new Uint32Array(bankBuffer);
  const members: number[] = [];
  for (const [slot, { bank, b }] of order.entries()) {
    const record = (slot * BANK_BYTES) / 4;
    bankWords[record] = members.length / 2;
    bankWords[record + 2] = bank.level;
    bankWords[record + 3] = b;
    for (const island of bank.islands) {
      const own = rings[island] ?? [];
      members.push(island, own.length - own.indexOf(b));
      if (island < MAX_BANK_ISLANDS) {
        const word = record + 4 + Math.floor(island / 32);
        bankWords[word] = (bankWords[word] ?? 0) + 2 ** (island % 32);
      }
    }
    bankWords[record + 1] = members.length / 2 - bankWords[record];
  }

  return {
    bankCount: banks.length,
    banks: bankBuffer,
    islandCount,
    islands,
    levels,
    members: new Uint32Array(members.length > 0 ? members : [0, 0]),
  };
}

const MODULE_FLOATS = 4;

const MODULE_KIND_CODES: Readonly<Record<ModuleKind, number>> = {
  config: 3,
  other: 4,
  source: 0,
  story: 2,
  test: 1,
  unknown: 5,
};

export function packModules(chart: Chart): Float32Array<ArrayBuffer> {
  const packed = new Float32Array(
    Math.max(chart.modules.length, 1) * MODULE_FLOATS
  );
  for (const [i, module] of chart.modules.entries()) {
    packed.set(
      [
        module.at[0],
        module.at[1],
        MODULE_KIND_CODES[module.kind],
        module.change?.frequent ? 1 : 0,
      ],
      i * MODULE_FLOATS
    );
  }
  return packed;
}

const ISLAND_PALETTE = [
  "#ecdea2",
  "#dec6da",
  "#eeb9a4",
  "#aacda5",
  "#f7ca88",
  "#e5c8d9",
  "#9ecba7",
  "#fadaa1",
  "#e0b0a7",
  "#dab6cf",
  "#eeeabe",
  "#e9d2aa",
] as const;

const HASH_MODULUS = 2 ** 32;

function hashOf(id: string): number {
  let hash = 5381;
  for (const unit of id) {
    hash = (hash * 33 + unit.charCodeAt(0)) % HASH_MODULUS;
  }
  return hash;
}

export function placeholderColors(
  chart: Chart,
  palette: MapParams["palette"]
): Float32Array<ArrayBuffer> {
  const colors = new Float32Array(Math.max(chart.islands.length, 1) * 4);
  for (const [i, island] of chart.islands.entries()) {
    const index = palette === "order" ? i : hashOf(island.id);
    const hex =
      ISLAND_PALETTE[index % ISLAND_PALETTE.length] ?? ISLAND_PALETTE[0];
    colors.set([...hexToLinear(hex), 1], i * 4);
  }
  return colors;
}
