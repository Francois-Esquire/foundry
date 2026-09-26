// Behavior across three modules of one package.
export interface Spread {
  n: number;
}

export function makeSpread(): Spread {
  return { n: 0 };
}
