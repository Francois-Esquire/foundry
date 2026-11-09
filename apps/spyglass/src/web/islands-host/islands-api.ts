/**
 * Spyglass imports the renderer's public entry through this barrel. See
 * `src/web/islands/README.md` for synchronization instructions.
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
