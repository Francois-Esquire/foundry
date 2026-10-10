/** Bumped when `ResponsibilityGroups` changes shape or meaning. */
export const RESPONSIBILITY_GROUPS_SCHEMA_VERSION = 1;

/**
 * Responsibilities joined by a greedy modularity merge over the import edges
 * and symbol flow between them. The viewer draws one as a district.
 */
export interface ResponsibilityGroup {
  /** The member most connected to the others: its id. */
  anchor: string;
  /**
   * The root-relative module of the anchor with the highest internal fan-in,
   * ties by id; absent only for an anchor without modules, which the
   * responsibility analysis does not produce.
   */
  anchorModule?: string;
  /** The anchor's summed affinity to the group's members. */
  anchorWeight: number;
  /** `responsibility-group:` and the first 12 hex digits of the SHA-256 of the sorted member ids, one per line, as a responsibility's id is made. */
  id: string;
  /** The anchor's label. */
  label: string;
  /** Member responsibility ids, sorted. */
  responsibilities: string[];
}

/** One package with internals, by its manifest id. */
export interface ResponsibilityGroupsPackage {
  /** In the order the merge left them. */
  groups: ResponsibilityGroup[];
  id: string;
  /** The responsibilities the merge joined to no other, sorted. */
  independent: string[];
}

/** A package's groups and its independent responsibilities, as the viewer keeps them. */
export type PackageResponsibilityGroups = Pick<
  ResponsibilityGroupsPackage,
  "groups" | "independent"
>;

/**
 * The `responsibility-groups` lens: every package whose internals the
 * dataset holds, sorted by id, and the complete packages it holds none for
 * (`missing`), sorted. A package that failed is in neither.
 */
export interface ResponsibilityGroups {
  missing: string[];
  packages: ResponsibilityGroupsPackage[];
}
