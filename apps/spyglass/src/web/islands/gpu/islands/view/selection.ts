import type { Chart } from "../../../data/chart";
import type { Banks } from "../sea/banks";
import type { Building } from "../world/world";

export type BuildingLookup = (id: number) => Building | undefined;

const BUILDING_ID_PREFIX = "building:";

export type Chosen =
  | { readonly kind: "island"; readonly island: number }
  | { readonly kind: "ring"; readonly bank: number }
  | {
      readonly kind: "module";
      readonly island: number;
      readonly module: number;
    }
  | {
      readonly kind: "building";
      readonly island: number;
      readonly building: number;
    }
  | null;

export const SELECTION_WORDS = 8;

export function selectionOf(words: Uint32Array): {
  chosen: Chosen;
  chosenAt: readonly [number, number];
  hovered: Chosen;
} {
  const of = (island: number, ring: number): Chosen => {
    if (island > 0) {
      return { island: island - 1, kind: "island" };
    }
    return ring > 0 ? { bank: ring - 1, kind: "ring" } : null;
  };
  const [chosenIsland = 0, chosenRing = 0, hoveredIsland = 0, hoveredRing = 0] =
    words;
  const at = new Float32Array(words.buffer, words.byteOffset + 16, 2);
  return {
    chosen: of(chosenIsland, chosenRing),
    chosenAt: [at[0] ?? 0, at[1] ?? 0],
    hovered: of(hoveredIsland, hoveredRing),
  };
}

export function selectionWords(
  chosen: Chosen,
  hovered: Chosen
): Uint32Array<ArrayBuffer> {
  const of = (thing: Chosen): [number, number] => {
    if (thing === null) {
      return [0, 0];
    }
    return thing.kind === "ring" ? [0, thing.bank + 1] : [thing.island + 1, 0];
  };
  return new Uint32Array([...of(chosen), ...of(hovered), 0, 0, 0, 0]);
}

export function chosenOf(
  chart: Chart,
  banks: Banks,
  id: string,
  buildingOf: BuildingLookup = () => undefined
): Chosen {
  const island = chart.islands.findIndex((candidate) => candidate.id === id);
  if (island >= 0) {
    return { island, kind: "island" };
  }
  const bank = banks.banks.findIndex((candidate) => candidate.id === id);
  if (bank >= 0) {
    return { bank, kind: "ring" };
  }
  if (id.startsWith(BUILDING_ID_PREFIX)) {
    const building = buildingOf(Number(id.slice(BUILDING_ID_PREFIX.length)));
    const home = chart.islands.findIndex(
      (candidate) => candidate.id === building?.island
    );
    return building && home >= 0
      ? { building: building.id, island: home, kind: "building" }
      : null;
  }
  const module = chart.modules.findIndex((candidate) => candidate.id === id);
  const owner = chart.modules[module]?.island;
  const home = chart.islands.findIndex((candidate) => candidate.id === owner);
  return module >= 0 && home >= 0
    ? { island: home, kind: "module", module }
    : null;
}

export function sameChosen(a: Chosen, b: Chosen): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  if (a.kind === "island" && b.kind === "island") {
    return a.island === b.island;
  }
  if (a.kind === "module" && b.kind === "module") {
    return a.module === b.module;
  }
  if (a.kind === "building" && b.kind === "building") {
    return a.building === b.building;
  }
  return a.kind === "ring" && b.kind === "ring" && a.bank === b.bank;
}

export function keptChosen(
  current: Chosen,
  read: Chosen,
  picked: boolean
): Chosen {
  const same =
    (current?.kind === "module" || current?.kind === "building") &&
    read?.kind === "island" &&
    read.island === current.island;
  return same && !picked ? current : read;
}

export const wordsPerBank = (islandCount: number): number =>
  Math.max(2, Math.ceil(islandCount / 32));

export function memberMasks(banks: Banks): Uint32Array<ArrayBuffer> {
  const words = wordsPerBank(banks.rings.length);
  const masks = new Uint32Array(Math.max(banks.banks.length, 1) * words);
  for (const [b, bank] of banks.banks.entries()) {
    for (const island of bank.islands) {
      const word = b * words + Math.floor(island / 32);
      masks[word] = (masks[word] ?? 0) + 2 ** (island % 32);
    }
  }
  return masks;
}

export interface Described {
  readonly files?: readonly string[];
  readonly id: string;
  readonly islands: readonly string[];
  readonly kind: "building" | "island" | "module" | "ring";
  readonly name: string;
}

const NAMED_FOUNDATIONS = 3;

export function describe(
  chart: Chart,
  banks: Banks,
  chosen: Chosen,
  buildingOf: BuildingLookup = () => undefined
): Described | null {
  if (chosen === null) {
    return null;
  }
  if (chosen.kind === "building") {
    const building = buildingOf(chosen.building);
    const island = chart.islands[chosen.island];
    if (!(building && island)) {
      return null;
    }
    const [first = ""] = building.files;
    return {
      files: building.files,
      id: `${BUILDING_ID_PREFIX}${building.id}`,
      islands: [island.name],
      kind: "building",
      name: first.slice(first.lastIndexOf("/") + 1),
    };
  }
  if (chosen.kind === "module") {
    const module = chart.modules[chosen.module];
    const island = chart.islands[chosen.island];
    if (!(module && island)) {
      return null;
    }
    return {
      files: [module.id],
      id: module.id,
      islands: [island.name],
      kind: "module",
      name: module.id.slice(module.id.lastIndexOf("/") + 1),
    };
  }
  if (chosen.kind === "island") {
    const island = chart.islands[chosen.island];
    if (!island) {
      return null;
    }
    return {
      id: island.id,
      islands: [island.name],
      kind: "island",
      name: island.name,
    };
  }
  const bank = banks.banks[chosen.bank];
  if (!bank) {
    return null;
  }
  const group = chart.groups.find((g) => g.id === bank.id);
  const names = (group?.foundations ?? []).map(
    (id) => chart.foundations.find((f) => f.id === id)?.name ?? id
  );
  const rest = names.length - NAMED_FOUNDATIONS;
  const listed = names.slice(0, NAMED_FOUNDATIONS).join(", ");
  return {
    id: bank.id,
    islands: bank.islands.flatMap((i) => chart.islands[i]?.name ?? []),
    kind: "ring",
    name: rest > 0 ? `${listed} +${rest}` : listed,
  };
}

export function coveredBy(
  chart: Chart,
  current: Chosen,
  next: Chosen,
  buildingOf: BuildingLookup
): boolean {
  if (current?.kind !== "building" || next === null) {
    return false;
  }
  if (next.kind === "island") {
    return next.island === current.island;
  }
  if (next.kind !== "module") {
    return false;
  }
  const file = chart.modules[next.module]?.id;
  return (
    file !== undefined &&
    (buildingOf(current.building)?.files.includes(file) ?? false)
  );
}
