import type { Credits, Money } from "./limit";

/**
 * What work used, in the provider's units. Absent means none reported. Input,
 * cached input, cache write and output tokens are disjoint; reasoning tokens
 * are the part of output spent reasoning, so they are not added to it.
 */
export interface Quantities {
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly images?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly seconds?: number;
}

/** What work cost, and how that figure was reached. */
export interface Charge {
  readonly amount: Money | Credits;
  readonly basis: "reported" | "priced" | "notional";
}

/** One of the client's own sessions within a span of consumption. */
export interface SessionConsumption {
  readonly charge?: Charge;
  readonly model: string;
  readonly quantities: Quantities;
  readonly session: string;
}

/** What work used over a span, read from an account's history. */
export interface Consumption {
  readonly bySession: readonly SessionConsumption[];
  readonly charge?: Charge;
  readonly since: Date;
  readonly total: Quantities;
}

const addQuantities = (a: Quantities, b: Quantities): Quantities => {
  const sum: Record<string, number> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    sum[key] = (sum[key] ?? 0) + value;
  }
  return sum;
};

const addCharges = (
  a: Charge | undefined,
  b: Charge | undefined
): Charge | undefined => {
  if (!(a && b)) {
    return;
  }
  if (a.basis !== b.basis || a.amount.unit !== b.amount.unit) {
    return;
  }
  return {
    amount: { ...a.amount, amount: a.amount.amount + b.amount.amount },
    basis: a.basis,
  };
};

/**
 * One account's consumption read through two credentials: the sessions of
 * both, with totals summed. A total charge is kept only when both charges
 * share a unit and basis.
 */
export const mergeConsumption = (
  a: Consumption | undefined,
  b: Consumption | undefined
): Consumption | undefined => {
  if (!(a && b)) {
    return a ?? b;
  }
  const charge = addCharges(a.charge, b.charge);
  return {
    bySession: [...a.bySession, ...b.bySession],
    since: a.since < b.since ? a.since : b.since,
    total: addQuantities(a.total, b.total),
    ...(charge ? { charge } : {}),
  };
};
