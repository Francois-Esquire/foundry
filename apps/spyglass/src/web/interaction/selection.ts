import type { SpyglassFile, Territory } from "../data/types";

/** What a click or a label's activation names on the chart: always an island, and what on it. */
export interface SpyglassSelection {
  file?: SpyglassFile;
  territory: Territory;
}
