/**
 * The one place Spyglass reaches the Islands renderer and its dataset
 * adapter, both in `src/web/islands/`: a synced copy of the renderer,
 * owned by another repository and never edited here (its README says how
 * it is synced). Everything else in Spyglass imports them from this file.
 */
// biome-ignore-all lint/performance/noBarrelFile: the single switch between Spyglass and the synced renderer copy.

export { chartFromFoundry as chartFromDataset } from "../islands/data/foundry";
export * from "../islands/gpu/islands/api";
