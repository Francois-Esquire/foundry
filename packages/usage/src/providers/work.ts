import { enrichFromSnapshot } from "@foundry/models/catalog/models-dev-snapshot";
import { costFromUsage } from "@foundry/models/cost";

import type {
  Charge,
  Consumption,
  Quantities,
  SessionConsumption,
} from "../consumption";

/** One piece of work as a client's history records it. */
export interface Work {
  readonly at: number;
  readonly model: string;
  readonly quantities: Quantities;
  readonly session: string;
  /** False at a speed tier, such as fast, that no bundled list price covers. */
  readonly standardSpeed: boolean;
}

export type Price = (
  model: string,
  quantities: Quantities
) => Charge | undefined;

type Rates = Parameters<typeof costFromUsage>[0];

/**
 * List prices for one vendor's models from the bundled models.dev snapshot,
 * matched exactly, so a model it does not list is unpriced. Rates are looked
 * up once per returned function.
 */
export const listPrices = (vendor: string): Price => {
  const rates = new Map<string, Rates | undefined>();
  const ratesOf = (model: string): Rates | undefined => {
    if (!rates.has(model)) {
      const [row] = enrichFromSnapshot([
        { id: model, kind: "text", modelId: model, vendor },
      ]);
      rates.set(model, row?.costs);
    }
    return rates.get(model);
  };
  return (model, counts) => {
    const costs = ratesOf(model);
    if (!costs) {
      return;
    }
    const cached = counts.cachedInputTokens ?? 0;
    const written = counts.cacheWriteTokens ?? 0;
    // Reasoning is inside output, so it is not passed to be billed again.
    const { total } = costFromUsage(costs, {
      cacheReadTokens: cached,
      cacheWriteTokens: written,
      inputTokens: (counts.inputTokens ?? 0) + cached + written,
      outputTokens: counts.outputTokens ?? 0,
    });
    return { amount: { amount: total, unit: "usd" }, basis: "priced" };
  };
};

/** Quantities with the zero counts left out. */
export const quantities = (counts: Quantities): Quantities =>
  Object.fromEntries(
    Object.entries(counts).filter(([, value]) => value > 0)
  ) as Quantities;

const add = (a: Quantities, b: Quantities): Quantities => {
  const sum: Record<string, number> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    sum[key] = (sum[key] ?? 0) + value;
  }
  return sum;
};

const addCharge = (
  a: Charge | undefined,
  b: Charge | undefined
): Charge | undefined =>
  a && b
    ? {
        ...a,
        amount: { ...a.amount, amount: a.amount.amount + b.amount.amount },
      }
    : undefined;

/**
 * Work since `since`, one entry per session and model, each piece priced on
 * its own and the charge given `basis`. An entry has a charge only when all of
 * its work was priced, and the total only when every entry has one.
 */
export const consumptionOf = (
  works: Iterable<Work>,
  since: Date,
  price: Price,
  basis: Charge["basis"]
): Consumption => {
  const entries = new Map<string, SessionConsumption>();
  for (const work of works) {
    const key = JSON.stringify([work.session, work.model]);
    const listed = work.standardSpeed
      ? price(work.model, work.quantities)
      : undefined;
    const charge: Charge | undefined = listed && { ...listed, basis };
    const entry = entries.get(key);
    entries.set(key, {
      charge: entry ? addCharge(entry.charge, charge) : charge,
      model: work.model,
      quantities: entry
        ? add(entry.quantities, work.quantities)
        : work.quantities,
      session: work.session,
    });
  }
  const bySession = [...entries.values()];
  const charges = bySession.map((entry) => entry.charge);
  const charge =
    charges.length > 0
      ? charges.reduce((sum, next) => addCharge(sum, next))
      : undefined;
  return {
    bySession,
    since,
    total: bySession.reduce<Quantities>(
      (sum, entry) => add(sum, entry.quantities),
      {}
    ),
    ...(charge ? { charge } : {}),
  };
};
