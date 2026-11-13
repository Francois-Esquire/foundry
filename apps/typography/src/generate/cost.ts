/** US dollars as written in the interface: $0.03, $12.00. */
const formatUsd = (usd: number) => `$${usd.toFixed(2)}`;

/** A charge the provider stated, or the plain fact that it stated none. Never zero for unknown. */
export const formatCost = (costUsd: number | undefined) =>
  costUsd === undefined ? "Not reported by the provider" : formatUsd(costUsd);
