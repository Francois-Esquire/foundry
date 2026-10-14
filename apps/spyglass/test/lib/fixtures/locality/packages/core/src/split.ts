// Produced in equal measure by core, store, and app; no package dominates.
export interface Split {
  p: number;
}

export function splitOne(): Split {
  return { p: 1 };
}

export function splitTwo(): Split {
  return { p: 2 };
}
