import { type Facts, factsOf } from "@/game/facts";
import { type LineItem, lineItems, type Verdict } from "@/game/rules";
import type { Encounter } from "@/model/thread";

type Rank = "S" | "A" | "B" | "C";

export interface Scorecard {
  readonly facts: Facts;
  readonly id: string;
  readonly items: readonly LineItem[];
  readonly rank: Rank | null;
  readonly total: number;
  readonly verdict: Verdict | null;
}

const RANKS: readonly (readonly [Rank, number])[] = [
  ["S", 170],
  ["A", 130],
  ["B", 90],
];

function rankOf(total: number): Rank {
  return RANKS.find(([, floor]) => total >= floor)?.[0] ?? "C";
}

export function scorecardOf(
  encounter: Encounter,
  verdict: Verdict | null,
  limit: number
): Scorecard {
  const facts = factsOf(encounter, limit);
  const items = lineItems(facts, verdict);
  const total = items.reduce((sum, item) => sum + item.amount, 0);
  return {
    facts,
    id: encounter.id,
    items,
    rank: verdict === "accept" || verdict === "reject" ? rankOf(total) : null,
    total,
    verdict,
  };
}
