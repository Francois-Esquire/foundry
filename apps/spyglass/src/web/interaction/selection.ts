import type { SpyglassFile, Territory } from "../data/types";
import type { NaturalFeature } from "../layout/natural-feature-inspection";

/** What a pointer hit or a click names on the chart: always an island, and what on it. */
export interface SpyglassSelection {
  compositeId?: string;
  feature?: NaturalFeature;
  file?: SpyglassFile;
  regionId?: string;
  symbol?: { id: string; name: string };
  territory: Territory;
  unmappedModule?: string;
}
