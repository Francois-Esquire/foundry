import type { Spread } from "./spread-a";

export function growSpread(spread: Spread): Spread {
  return { n: spread.n + 1 };
}
