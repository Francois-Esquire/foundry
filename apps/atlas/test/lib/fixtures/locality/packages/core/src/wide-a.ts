// Behavior in core, store, and app; app reaches core only through store.
export interface Wide {
  w: number;
}

export function makeWide(): Wide {
  return { w: 0 };
}
