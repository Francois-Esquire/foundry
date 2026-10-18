/** The developer session's boundary overlays, all off by default. */
export const defaultBoundaries = {
  clearance: false,
  coasts: false,
  footprint: false,
  groups: false,
  outer: false,
  pockets: false,
};

export type BoundaryId = keyof typeof defaultBoundaries;
export type BoundaryVisibility = Record<BoundaryId, boolean>;
