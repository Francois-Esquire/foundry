// The model stays here; most behavior producing it has accumulated in store and app.
export interface Drift {
  d: number;
}

export interface DriftExt extends Drift {
  label: string;
}

export type DriftAlias = Drift;

export type DriftLike = Drift;

export class DriftImpl implements Drift {
  d = 0;
}

export function driftLocal(): Drift {
  return { d: 0 };
}
