/**
 * The selection: an island, a building on it, or a ring, chosen by a click
 * and hovered by the pointer. The GPU knows only indices (pick.wgsl reads them off the maps
 * and keeps them, water.wgsl highlights them); what one stands for is read
 * here, from the chart. A ring is a bank: a group of islands that share the same
 * foundations, the dependencies they all stand on.
 *
 * Pure, no GPU.
 */
import type { Chart } from "../../../data/chart";
import type { Banks } from "../sea/banks";
import type { Building } from "../world/world";

/** The world plan's buildings by id, for what a building stands for; none before a plan. */
export type BuildingLookup = (id: number) => Building | undefined;

/** The prefix of a building's id in `Described` and `chosenOf`: `building:<id>`. */
export const BUILDING_ID_PREFIX = "building:";

/**
 * An island by index in `chart.islands`, a ring by index in `Banks.banks`,
 * a module (a file) by index in `chart.modules` with its island's index, or
 * a building by its id in the world plan with its island's index. The GPU
 * has no highlight of its own for a file or a building: either shows as its
 * island chosen. Only a choice by id makes a module; only a click on its
 * footprint makes a building (selection-controller.ts `buildingAt`).
 */
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

/** Words in pick.wgsl's `Selection`: four indices, then the chosen point and its padding as floats. */
export const SELECTION_WORDS = 8;

/**
 * The selection as pick.wgsl keeps it: an island as its index + 1, a ring
 * as its bank's index + 1, 0 for none; the chosen, then the hovered; then
 * the chart point the last click chose at.
 */
export function selectionOf(words: Uint32Array): {
	chosen: Chosen;
	chosenAt: readonly [number, number];
	hovered: Chosen;
} {
	const of = (island: number, ring: number): Chosen => {
		if (island > 0) {
			return { kind: "island", island: island - 1 };
		}
		return ring > 0 ? { kind: "ring", bank: ring - 1 } : null;
	};
	// The pick's readback is always four words, so the fallbacks never apply.
	const [chosenIsland = 0, chosenRing = 0, hoveredIsland = 0, hoveredRing = 0] =
		words;
	const at = new Float32Array(words.buffer, words.byteOffset + 16, 2);
	return {
		chosen: of(chosenIsland, chosenRing),
		chosenAt: [at[0] ?? 0, at[1] ?? 0],
		hovered: of(hoveredIsland, hoveredRing),
	};
}

/**
 * The selection's words as pick.wgsl keeps them, the other way from
 * `selectionOf`: for writing a choice made by id rather than by a pick.
 */
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
	// The chosen point stays zero: a choice by id has none.
	return new Uint32Array([...of(chosen), ...of(hovered), 0, 0, 0, 0]);
}

/**
 * What a chart id names: an island by its id, else a ring by its group's
 * id (the id `describe` gives), else a building by `building:<id>`, else a
 * module by its id (its path), else nothing.
 */
export function chosenOf(
	chart: Chart,
	banks: Banks,
	id: string,
	buildingOf: BuildingLookup = () => undefined
): Chosen {
	const island = chart.islands.findIndex((candidate) => candidate.id === id);
	if (island >= 0) {
		return { kind: "island", island };
	}
	const bank = banks.banks.findIndex((candidate) => candidate.id === id);
	if (bank >= 0) {
		return { kind: "ring", bank };
	}
	if (id.startsWith(BUILDING_ID_PREFIX)) {
		const building = buildingOf(Number(id.slice(BUILDING_ID_PREFIX.length)));
		const home = chart.islands.findIndex(
			(candidate) => candidate.id === building?.island
		);
		return building && home >= 0
			? { kind: "building", island: home, building: building.id }
			: null;
	}
	const module = chart.modules.findIndex((candidate) => candidate.id === id);
	const owner = chart.modules[module]?.island;
	const home = chart.islands.findIndex((candidate) => candidate.id === owner);
	return module >= 0 && home >= 0
		? { kind: "module", island: home, module }
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

/**
 * What a readback of the GPU's selection leaves chosen. The GPU knows no
 * modules or buildings: either reads back as its island, and stays as it
 * is unless a click or Escape (`picked`) could have changed it since.
 */
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

/**
 * Words per bank in `memberMasks`: a bit per island, at least two, the
 * layout small charts' water reads as one `vec2u` (water.wgsl `members`).
 * selection-resolve.wgsl strides the masks by it too.
 */
export const wordsPerBank = (islandCount: number): number =>
	Math.max(2, Math.ceil(islandCount / 32));

/** Each bank's islands, `wordsPerBank` words a bank. */
export function memberMasks(banks: Banks): Uint32Array<ArrayBuffer> {
	const words = wordsPerBank(banks.rings.length);
	const masks = new Uint32Array(Math.max(banks.banks.length, 1) * words);
	for (const [b, bank] of banks.banks.entries()) {
		for (const island of bank.islands) {
			// One bit per island: a bank lists each island once.
			const word = b * words + Math.floor(island / 32);
			masks[word] = (masks[word] ?? 0) + 2 ** (island % 32);
		}
	}
	return masks;
}

/** What a chosen thing is, in the chart's own terms. */
export interface Described {
	/**
	 * The files it holds, by module id: a module's own, or a building's
	 * households. Absent for an island or a ring.
	 */
	readonly files?: readonly string[];
	/** The chart's id: the island's, the ring's group's, the module's (its path), or `building:<id>` for a building. */
	readonly id: string;
	/** The islands it spans, by name: the island itself, the ring's members, or the module's or building's island. */
	readonly islands: readonly string[];
	readonly kind: "building" | "island" | "module" | "ring";
	/** What it shares or is: an island's name, a ring's dependencies, a module's file name, a building's first file name. */
	readonly name: string;
}

/** The dependencies a ring's name lists before it counts the rest. */
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
			id: `${BUILDING_ID_PREFIX}${building.id}`,
			name: first.slice(first.lastIndexOf("/") + 1),
			kind: "building",
			islands: [island.name],
			files: building.files,
		};
	}
	if (chosen.kind === "module") {
		const module = chart.modules[chosen.module];
		const island = chart.islands[chosen.island];
		if (!(module && island)) {
			return null;
		}
		return {
			id: module.id,
			name: module.id.slice(module.id.lastIndexOf("/") + 1),
			kind: "module",
			islands: [island.name],
			files: [module.id],
		};
	}
	if (chosen.kind === "island") {
		const island = chart.islands[chosen.island];
		if (!island) {
			return null;
		}
		return {
			id: island.id,
			name: island.name,
			kind: "island",
			islands: [island.name],
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
		name: rest > 0 ? `${listed} +${rest}` : listed,
		kind: "ring",
		islands: bank.islands.flatMap((i) => chart.islands[i]?.name ?? []),
	};
}

/**
 * Whether choosing `next` by id would only name again what `current`
 * already is: a building's island, or one of its files. A host echoing a
 * building it was told of, as the file or island it stores, keeps the
 * building chosen rather than replacing it.
 */
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
