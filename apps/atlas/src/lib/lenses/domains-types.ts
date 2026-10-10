import type { PlacementLabel, PlacementLevel } from "./placement-types";

/** Bumped when `Domains` changes shape or meaning. */
export const DOMAINS_SCHEMA_VERSION = 1;

/** What kind of place a facet names: a package by its root's path, a folder, a file, or a symbol. */
export type DomainPlaceKind = "package" | "folder" | "file" | "symbol";

/**
 * The domain label of a placed place in a domain. `shares-domain`: every
 * consumer module in another package lies in a place that shares one of its
 * domains, and no consumer is unindexed, since an unindexed file's domains
 * cannot be told. Otherwise the placement label stands: `departs` is then a domain
 * departure as well as a placement departure, since some away consumer
 * shares none of its domains; `spread` and `fits` keep their meaning.
 */
export type DomainLabel = PlacementLabel | "shares-domain";

/** One declared domain, flattened out of its nesting. */
export interface DomainMatch {
  name: string;
  /** The domains it is nested in, outermost first; empty at the top level. */
  parents: string[];
  /**
   * Its own facets that name a place in the dataset, sorted by place; a
   * facet is the place's address. A match gives no label: only the places
   * the `placement` lens lists get a domain label, in `placements`.
   */
  places: { kind: DomainPlaceKind; place: string }[];
  /** As declared; absent when the domain declares none. */
  reason?: string;
  /** Its own facets that name no place in the dataset, sorted. */
  unmatched: string[];
  /** As declared; absent when the domain declares none. */
  weight?: number;
}

/** One place the `placement` lens lists that lies in at least one domain. */
export interface DomainPlacement {
  /**
   * Its consumer modules in other packages: `shared`, those in a place
   * sharing one of its domains, of `total`; and `unindexed`, placement's
   * count of consumers in no package of the module index, whose domains
   * are unknown, so that any of them withholds `shares-domain`.
   */
  away: { shared: number; total: number; unindexed: number };
  domainLabel: DomainLabel;
  /** Every domain the place is in, the ones its own facets name and their parents, sorted. */
  domains: string[];
  level: PlacementLevel;
  /** The package the place lives in, by manifest id. */
  package: string;
  place: string;
  /** The `placement` lens's own label, kept beside the domain label. */
  placementLabel: PlacementLabel;
  /** The domains it shares with any of its away consumer modules, sorted; empty when none. */
  sharedDomains: string[];
}

/**
 * The `domains` lens. `domains` holds every declared domain, nested ones
 * included, sorted by name; `placements` every place of the `placement`
 * lens inside a domain, sorted by place, then level, then package.
 */
export interface Domains {
  domains: DomainMatch[];
  placements: DomainPlacement[];
}
