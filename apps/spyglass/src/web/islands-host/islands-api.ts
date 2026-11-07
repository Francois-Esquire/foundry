/**
 * The one place Spyglass reaches the Islands renderer, in `src/web/islands/`:
 * a synced copy, owned by another repository and never edited here (its
 * README says how it is synced). Its public entry gives the React
 * component and its hooks, the dataset adapter and the types the viewer
 * reads; everything else in Spyglass imports them from this file.
 */
// biome-ignore-all lint/performance/noBarrelFile: the single switch between Spyglass and the synced renderer copy.

export {
  type Chart,
  chartFromFoundry as chartFromDataset,
  DEFAULT_ISLANDS_SETTINGS,
  type Described,
  type Islands,
  IslandsCanvas,
  type IslandsControls,
  type IslandsDebug,
  type IslandsError,
  type IslandsFrame,
  type IslandsSettings,
  type IslandsStats,
  type IslandsView,
  useIslands,
  useIslandsFrame,
} from "../islands/gpu/islands/api";
