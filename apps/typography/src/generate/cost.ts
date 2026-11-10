/**
 * What a model run may cost, before it starts. The figure is an estimate
 * from a listed price, never a charge: the provider states no cost per
 * request, so the real one shows only on the provider's own account.
 */

export interface ListedRate {
  /** When the price was read from the provider's listing. */
  readonly listedOn: string;
  /** What the listing leaves open, when it leaves something open. */
  readonly note?: string;
  /** US dollars for one unit, as the provider lists it. */
  readonly usdPerUnit: number;
}

/** Listed prices on fal, by model endpoint. */
const LISTED_RATES: Readonly<Record<string, ListedRate | undefined>> = {
  "ideogram/vector/text-to-vector": {
    listedOn: "10 November 2026",
    usdPerUnit: 0.01,
  },
  "openai/gpt-image-2.6/flare/edit": {
    listedOn: "10 November 2026",
    note: "The listing does not say how many units one image takes.",
    usdPerUnit: 1,
  },
};

export interface CostEstimate {
  readonly rate: ListedRate;
  readonly targets: number;
  /** Targets multiplied by the listed rate. */
  readonly usd: number;
}

/** The estimate for a run of `targets` glyphs, or nothing for a model with no listed price. */
export const estimateCost = (
  model: string,
  targets: number
): CostEstimate | undefined => {
  const rate = LISTED_RATES[model];
  return rate && { rate, targets, usd: targets * rate.usdPerUnit };
};

/** US dollars as written in the interface: $0.03, $12.00. */
export const formatUsd = (usd: number) => `$${usd.toFixed(2)}`;

/** A charge the provider stated, or the plain fact that it stated none. Never zero for unknown. */
export const formatCost = (costUsd: number | undefined) =>
  costUsd === undefined ? "Not reported by the provider" : formatUsd(costUsd);
