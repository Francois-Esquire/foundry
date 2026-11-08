/** The chart packed for the map kernels. Pure CPU data, with no GPU resources. */
import type { Chart, ModuleKind } from "../../../data/chart";
import { banksOf } from "../sea/banks";
import { hexToLinear } from "../sea/sea-params";
import type { MapParams } from "./map-params";

// --- Coast packing ---------------------------------------------------------

/** Bytes per island record: start, count, two pad words, then bounds. */
const COAST_BYTES = 32;
/** Floats per segment record: a.x, a.y, b.x, b.y. */
const SEGMENT_FLOATS = 4;

export interface PackedCoasts {
  /** One record per island, in chart order: segment range and bounds. */
  readonly coasts: ArrayBuffer;
  readonly islandCount: number;
  readonly segmentCount: number;
  /** Every ring of every coast polygon as closed segments. */
  readonly segments: Float32Array<ArrayBuffer>;
}

/** The chart's coasts as the distance kernel reads them. */
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
  // Storage bindings need at least one record, even for an empty chart.
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
          // The ring closes on itself; the index wraps within it, so the fallback never applies.
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

// --- Bank packing ----------------------------------------------------------

/**
 * The original height kernel's private-state capacity. Larger charts use
 * striped bake workspace; every island is still packed and rendered.
 */
export const MAX_BANK_ISLANDS = 64;
/** The coasts map's side, texels: each island's distance, read bilinear. */
export const COASTS_RESOLUTION = 512;
/** Bytes per piece record: segment start, segment count, two pad words, bounds. */
const PIECE_BYTES = 32;
/** Bytes per bank island record: rings, size, reach. */
const BANK_ISLAND_BYTES = 12;
/** Bytes per bank record: member start, member count, level, a pad word, a 64-bit member mask. */
const BANK_BYTES = 24;

export interface PackedPieces {
  /** Per island: its pieces' start and count. */
  readonly islands: Uint32Array<ArrayBuffer>;
  /** One record per coast polygon: its segment range in `packCoasts`' segments, and bounds. */
  readonly pieces: ArrayBuffer;
}

/**
 * Each island's coast polygons as ranges of `packCoasts`' segments, with
 * their bounds: the coasts kernel measures one island's pieces, the
 * nearest first, culling the rest by their bounds.
 */
export function packPieces(chart: Chart): PackedPieces {
  const pieceCount = chart.islands.reduce(
    (n, island) => n + island.shape.coast.length,
    0
  );
  // Storage bindings need at least one record, even for an empty chart.
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
  /** One record per bank, by level then the global order: member range, level and mask. */
  readonly banks: ArrayBuffer;
  readonly islandCount: number;
  /** One record per island the banks follow: its rings, its size and its reach (1). */
  readonly islands: ArrayBuffer;
  /** How many levels the banks stand on (banks.ts `banksOf`). */
  readonly levels: number;
  /** Per bank member: the island's index, and how many of its rings stand from this one up. */
  readonly members: Uint32Array<ArrayBuffer>;
}

/** The chart's banks (banks.ts `banksOf`) as the height kernel reads them. */
export function packBanks(chart: Chart): PackedBanks {
  const { banks, levels, rings } = banksOf(chart);
  const islandCount = chart.islands.length;

  const islands = new ArrayBuffer(Math.max(islandCount, 1) * BANK_ISLAND_BYTES);
  const islandWords = new Uint32Array(islands);
  const islandFloats = new Float32Array(islands);
  for (const [i, island] of chart.islands.entries()) {
    // `banksOf` gives every island its list of rings, empty or not.
    islandWords[i * 3] = rings[i]?.length ?? 0;
    islandFloats[i * 3 + 1] = island.size;
    // The island's own scale on its stack's reach: the one place to set
    // an island apart.
    islandFloats[i * 3 + 2] = 1;
  }

  // By level, the deepest first; within a level, the global order.
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
      // A bank's islands are the chart's, and each has its list of rings.
      const own = rings[island] ?? [];
      members.push(island, own.length - own.indexOf(b));
      // One bit per island: a bank lists each island once, so adding its
      // power of two sets it.
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
    // Storage bindings need at least one record, even when there are none.
    members: new Uint32Array(members.length > 0 ? members : [0, 0]),
  };
}

// --- Module packing ----------------------------------------------------------

/** Floats per module record (files.wgsl `File`): x, y, kind code, frequent. */
const MODULE_FLOATS = 4;

/** Each kind's code in files.wgsl, which colours by it. */
const MODULE_KIND_CODES: Readonly<Record<ModuleKind, number>> = {
  config: 3,
  other: 4,
  source: 0,
  story: 2,
  test: 1,
  unknown: 5,
};

/** The chart's modules as the files kernel reads them, in chart order. */
export function packModules(chart: Chart): Float32Array<ArrayBuffer> {
  // Storage bindings need at least one record, even with no modules.
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

// --- Island colours ---------------------------------------------------------

/**
 * The pastel caps of Spyglass's reference atlas, sampled off its island
 * tops: paler and greyer than saturated pastels, so they still read once
 * the light and the cliff rock darken them.
 */
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

/** A djb2 hash of the id's UTF-16 units. */
function hashOf(id: string): number {
  let hash = 5381;
  for (const unit of id) {
    hash = (hash * 33 + unit.charCodeAt(0)) % HASH_MODULUS;
  }
  return hash;
}

/**
 * Each island's colour, linear RGBA, packed for the paint kernel: a cap
 * from `ISLAND_PALETTE`, in turn by order, or by a hash of the id so an
 * island keeps its colour wherever it appears.
 */
export function placeholderColors(
  chart: Chart,
  palette: MapParams["palette"]
): Float32Array<ArrayBuffer> {
  const colors = new Float32Array(Math.max(chart.islands.length, 1) * 4);
  for (const [i, island] of chart.islands.entries()) {
    const index = palette === "order" ? i : hashOf(island.id);
    // The index wraps within the palette, so the first colour never stands in.
    const hex =
      ISLAND_PALETTE[index % ISLAND_PALETTE.length] ?? ISLAND_PALETTE[0];
    colors.set([...hexToLinear(hex), 1], i * 4);
  }
  return colors;
}
