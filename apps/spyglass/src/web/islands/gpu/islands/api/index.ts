/**
 * The Islands renderer's public surface, its one entry: `createIslands`
 * for any host, `<IslandsCanvas>` for React, and the types they take and
 * give. It is handed a `Chart` (data/chart.ts) and never fetches one.
 */
// biome-ignore-all lint/performance/noBarrelFile: the renderer's one public entry, so a host copies and imports a single file.
export type { Chart, Point } from "../../../data/chart";
export type { IslandsSettings } from "../params";
export { islandsParams } from "../params";
export type { Described } from "../view/selection";
export type {
	Islands,
	IslandsControls,
	IslandsDebug,
	IslandsError,
	IslandsEvent,
	IslandsEvents,
	IslandsFrame,
	IslandsFrameOptions,
	IslandsOptions,
	IslandsStats,
	IslandsView,
	Projected,
} from "./islands";
export {
	createIslands,
	DEFAULT_ISLANDS_SETTINGS,
	ISLANDS_FIELD_OF_VIEW,
} from "./islands";
export type { IslandsCanvasProps } from "./islands-canvas";
export { IslandsCanvas } from "./islands-canvas";
