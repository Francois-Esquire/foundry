import type { Chart } from "../../../data/chart";
import { indexChart } from "../../../data/index";

interface Bank {
  readonly id: string;
  readonly islands: readonly number[];
  readonly level: number;
}

export interface Banks {
  readonly banks: readonly Bank[];
  readonly levels: number;
  readonly rings: readonly (readonly number[])[];
}

const byId = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
};

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
    own.sort((a, b) => (banks[a]?.level ?? 0) - (banks[b]?.level ?? 0));
  }
  const levels = banks.reduce((n, bank) => Math.max(n, bank.level + 1), 0);
  return { banks, levels, rings };
}
