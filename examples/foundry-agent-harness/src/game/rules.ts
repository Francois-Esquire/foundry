import type { Facts } from "@/game/facts";
import type { Effort } from "@/model/context";

export type Verdict = "accept" | "reject" | "skip";

export interface LineItem {
  readonly amount: number;
  readonly label: string;
}

interface Rule {
  readonly award: (facts: Facts) => number;
  readonly label: string;
}

const GUNS: Readonly<Record<string, number>> = {
  haiku: 30,
  opus: 0,
  sonnet: 15,
};
const AMMO: Readonly<Record<Effort, number>> = { high: 0, low: 20, medium: 10 };
const LIGHT_TOUCH = 0.6;
const PAR_BASE = 10_000;
const PAR_PER_STEP = 20_000;
const CONSOLATION = 10;

function underPar({ steps, tokens }: Facts): boolean {
  return tokens.input + tokens.output < PAR_BASE + PAR_PER_STEP * steps;
}

const RULES: readonly Rule[] = [
  { award: () => 50, label: "Accepted" },
  { award: ({ finished }) => 10 * finished, label: "Steps done" },
  {
    award: ({ failedCalls, outcome }) =>
      failedCalls === 0 && outcome !== "failed" ? 25 : 0,
    label: "Clean run",
  },
  {
    award: ({ left, rearmed }) => (left >= LIGHT_TOUCH && !rearmed ? 20 : 0),
    label: "Light touch",
  },
  { award: ({ weapon }) => GUNS[weapon.model] ?? 0, label: "Lighter gun" },
  { award: ({ weapon }) => AMMO[weapon.effort], label: "Less ammo" },
  { award: (facts) => (underPar(facts) ? 25 : 0), label: "Under par" },
];

function capped(facts: Facts, items: readonly LineItem[]): LineItem[] {
  const subtotal = items.reduce((sum, item) => sum + item.amount, 0);
  if (facts.outcome !== "failed" || subtotal <= CONSOLATION) {
    return [...items];
  }
  return [...items, { amount: CONSOLATION - subtotal, label: "Failed run" }];
}

export function lineItems(facts: Facts, verdict: Verdict | null): LineItem[] {
  if (verdict !== "accept") {
    return [];
  }
  return capped(
    facts,
    RULES.map(({ award, label }) => ({ amount: award(facts), label })).filter(
      (item) => item.amount !== 0
    )
  );
}
