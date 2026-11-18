import type { PlacementLabel, PlacementLevel } from "./placement-types";

export const DOMAINS_SCHEMA_VERSION = 1;

export type DomainPlaceKind = "package" | "folder" | "file" | "symbol";

export type DomainLabel = PlacementLabel | "shares-domain";

export interface DomainMatch {
  name: string;
  parents: string[];
  places: { kind: DomainPlaceKind; place: string }[];
  reason?: string;
  unmatched: string[];
  weight?: number;
}

export interface DomainPlacement {
  away: { shared: number; total: number; unindexed: number };
  domainLabel: DomainLabel;
  domains: string[];
  level: PlacementLevel;
  package: string;
  place: string;
  placementLabel: PlacementLabel;
  sharedDomains: string[];
}

export interface Domains {
  domains: DomainMatch[];
  placements: DomainPlacement[];
}
