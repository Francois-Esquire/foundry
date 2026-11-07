/**
 * The Islands renderer's public surface, its one entry, for a React host:
 * `<IslandsCanvas>`, which draws a chart and holds its children over it,
 * `useIslands` and `useIslandsFrame` for those children, the Foundry
 * adapter that makes a `Chart` from Foundry's map, and the types a host
 * reads. The renderer is handed a `Chart` (data/chart.ts) and never
 * fetches one. The engine behind the component (`createIslands`,
 * islands.ts) is internal.
 */
// biome-ignore-all lint/performance/noBarrelFile: the renderer's one public entry, so a host copies and imports a single file.
export type { Chart } from "../../../data/chart";
export { chartFromFoundry } from "../../../data/foundry";
export type { IslandsSettings } from "../params";
export type { Described } from "../view/selection";
export { DEFAULT_ISLANDS_SETTINGS } from "./islands";
export {
  IslandsCanvas,
  useIslands,
  useIslandsFrame,
} from "./islands-canvas";
export type {
  Islands,
  IslandsControls,
  IslandsDebug,
  IslandsError,
  IslandsFrame,
  IslandsStats,
  IslandsView,
} from "./types";
