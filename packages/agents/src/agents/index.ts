export type { AgentToolConfig } from "./agent-tool";
// biome-ignore lint/performance/noBarrelFile: This is the exported @foundry/agents/agents public API.
export { createAgentTool } from "./agent-tool";
export type {
  AgentModel,
  ModelLimits,
  ModelRoute,
  ObserveTurn,
  TurnObservation,
} from "./model";
export type {
  AgentCompatibilityProjection,
  AgentCompatibilityRegistry,
  AgentEntry,
  AgentPresetCatalogEntry,
  AgentPresetIdentity,
  AgentRegistry,
} from "./registry";
export {
  createAgentCompatibilityRegistry,
  createAgentRegistry,
  resolveAgentEntry,
} from "./registry";
export type {
  AgentExecutionContext,
  AgentPreset,
  AgentPresetContext,
  AgentSessionContext,
  AgentSurface,
  ResolveAgentContext,
} from "./resolve";
export { createAgentPreset, resolveAgent } from "./resolve";
export type { AgentSource, AgentSpec } from "./spec";
