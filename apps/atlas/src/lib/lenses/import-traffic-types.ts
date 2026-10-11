/** Bumped when `ImportTraffic` changes shape or meaning. */
export const IMPORT_TRAFFIC_SCHEMA_VERSION = 1;

/**
 * One ordered package pair with an import edge from one into the other: the
 * files at each end of its edges.
 */
export interface ImportTrafficPair {
  /** Files of `from` that import a file of `to`: the edges' sources, sorted by code unit. */
  consumerFiles: string[];
  /** The importing package, by manifest id. */
  from: string;
  /** Files of `to` that a file of `from` imports: the edges' targets, sorted by code unit. */
  supplierFiles: string[];
  /** The imported package, by manifest id. */
  to: string;
}

/**
 * The `import-traffic` lens: every ordered package pair the module edges
 * cross, sorted by `from`, then `to`, by code unit. How many edges a pair
 * has is the dependency graph's to say, not this lens's; a file's own
 * import counts are its module index entry's `fanIn` and `fanOut`.
 */
export interface ImportTraffic {
  pairs: ImportTrafficPair[];
}
