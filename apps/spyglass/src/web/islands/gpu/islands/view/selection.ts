/**
 * The selection: an island or a ring, chosen by a click and hovered by the
 * pointer. The GPU knows only indices (pick.wgsl reads them off the maps
 * and keeps them, water.wgsl highlights them); what one stands for is read
 * here, from the chart. A ring is a bank: a group of islands that share the same
 * foundations, the dependencies they all stand on.
 *
 * Pure, no GPU.
 */
import type { Chart } from "../../../data/chart";
import type { Banks } from "../sea/banks";

/**
 * An island by index in `chart.islands`, a ring by index in `Banks.banks`,
 * or a module (a file) by index in `chart.modules` with its island's
 * index. The GPU has no highlight of its own for a file: a chosen module
 * shows as its island chosen, and only a choice by id makes one.
 */
export type Chosen =
	| { readonly kind: "island"; readonly island: number }
	| { readonly kind: "ring"; readonly bank: number }
	| {
			readonly kind: "module";
			readonly island: number;
			readonly module: number;
	  }
	| null;

/**
 * The selection as pick.wgsl keeps it: an island as its index + 1, a ring
 * as its bank's index + 1, 0 for none; the chosen, then the hovered.
 */
export function selectionOf(words: Uint32Array): {
	chosen: Chosen;
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
	return {
		chosen: of(chosenIsland, chosenRing),
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
	return new Uint32Array([...of(chosen), ...of(hovered)]);
}

/**
 * What a chart id names: an island by its id, else a ring by its group's
 * id (the id `describe` gives), else a module by its id (its path), else
 * nothing.
 */
export function chosenOf(chart: Chart, banks: Banks, id: string): Chosen {
	const island = chart.islands.findIndex((candidate) => candidate.id === id);
	if (island >= 0) {
		return { kind: "island", island };
	}
	const bank = banks.banks.findIndex((candidate) => candidate.id === id);
	if (bank >= 0) {
		return { kind: "ring", bank };
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
	return a.kind === "ring" && b.kind === "ring" && a.bank === b.bank;
}

/**
 * What a readback of the GPU's selection leaves chosen. The GPU knows no
 * modules: a chosen module reads back as its island, and stays the module
 * unless a click or Escape (`picked`) could have changed it since.
 */
export function keptChosen(
	current: Chosen,
	read: Chosen,
	picked: boolean
): Chosen {
	const same =
		current?.kind === "module" &&
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
	/** The chart's id: the island's, the ring's group's, or the module's (its path). */
	readonly id: string;
	/** The islands it spans, by name: the island itself, the ring's members, or the module's island. */
	readonly islands: readonly string[];
	readonly kind: "island" | "module" | "ring";
	/** What it shares or is: an island's name, a ring's dependencies, a module's file name. */
	readonly name: string;
}

/** The dependencies a ring's name lists before it counts the rest. */
const NAMED_FOUNDATIONS = 3;

export function describe(
	chart: Chart,
	banks: Banks,
	chosen: Chosen
): Described | null {
	if (chosen === null) {
		return null;
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
