/**
 * The banks: the chart's groups as the sea floor stacks them. A group is a
 * bank, and every island in it gets one ring for it. Nothing else of the
 * chart is read here: which islands there are, and which groups they are
 * in.
 *
 * **The one global order**: the most widely shared group (most islands)
 * first, the most particular last; ties by id, in code-unit order, so the
 * order is stable whatever order the source lists the groups in.
 *
 * **Levels.** The band between the platform and the top ring is cut into
 * equal levels, and each bank stands at one of them everywhere, so a plate
 * two islands share is flat at one depth. The levels are dealt in the
 * global order, first fit: each bank takes the lowest level none of its
 * islands has yet. The widely shared banks so stand deepest, and no island
 * has two banks at one level. The level count is the most any bank needed;
 * it is at least the most rings any island has, and for Foundry's chart it
 * equals it (19). An island's rings are its banks by level, bottom first,
 * which is the global order except where first fit dropped a later bank
 * into a gap (five of Foundry's islands).
 *
 * Pure, no GPU: `maps.ts` packs the result for the height kernel.
 */
import type { Chart } from "../../../data/chart";
import { indexChart } from "../../../data/index";

export interface Bank {
	readonly id: string;
	/** Its islands, by index in `chart.islands`, ascending. */
	readonly islands: readonly number[];
	/** The level it stands at, 0 the deepest, under `Banks.levels`. */
	readonly level: number;
}

export interface Banks {
	/** Every group as a bank, in the global order. */
	readonly banks: readonly Bank[];
	/** How many levels the banks stand on: one past the highest. 0 with no banks. */
	readonly levels: number;
	/**
	 * Per island (by index in `chart.islands`): the banks it stands in, by
	 * index in `banks`, by level, bottom ring first. Empty for an island in
	 * no group.
	 */
	readonly rings: readonly (readonly number[])[];
}

const byId = (a: string, b: string): number => {
	if (a < b) {
		return -1;
	}
	return a > b ? 1 : 0;
};

/** The chart's groups as banks in the global order, their levels, and each island's rings. */
export function banksOf(chart: Chart): Banks {
	const { islandOrder } = indexChart(chart);
	const ordered = chart.groups
		.map((group) => ({
			id: group.id,
			islands: [
				...new Set(
					group.islands.flatMap((id) => {
						const index = islandOrder.get(id);
						return index === undefined ? [] : [index];
					})
				),
			].sort((a, b) => a - b),
		}))
		.sort((a, b) => b.islands.length - a.islands.length || byId(a.id, b.id));

	// First fit: the lowest level free on every one of the bank's islands.
	// A bank's islands index the chart's, so every lookup below finds its set
	// or list; the optional chains only narrow the types.
	const taken: Set<number>[] = chart.islands.map(() => new Set());
	const banks: Bank[] = ordered.map((bank) => {
		let level = 0;
		while (bank.islands.some((island) => taken[island]?.has(level))) {
			level += 1;
		}
		for (const island of bank.islands) {
			taken[island]?.add(level);
		}
		return { ...bank, level };
	});

	const rings: number[][] = chart.islands.map(() => []);
	for (const [b, bank] of banks.entries()) {
		for (const island of bank.islands) {
			rings[island]?.push(b);
		}
	}
	for (const own of rings) {
		// The rings are the banks' own indexes, so every bank is there.
		own.sort((a, b) => (banks[a]?.level ?? 0) - (banks[b]?.level ?? 0));
	}
	const levels = banks.reduce((n, bank) => Math.max(n, bank.level + 1), 0);
	return { banks, levels, rings };
}
