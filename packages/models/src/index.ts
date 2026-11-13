/**
 * The AI SDK model contract our providers hand back. Re-exported so hosts can
 * type a custom provider without depending on the SDK's provider spec package.
 */
export type { LanguageModelV4, ProviderV4 } from "@ai-sdk/provider";
/** Live access shapes only; the interaction itself is not in this entry. */
export type { LiveAccess, LiveTarget } from "./live/types";
export type { LanguageModelOptions, Provider, TurnLimit } from "./provider";
// biome-ignore lint/performance/noBarrelFile: This is the exported @foundry/models public API.
export { fromSdk, operationsOf, servesKind } from "./provider";
export type {
  CapabilityFact,
  DeliveryForm,
  InputForm,
  InteractionMode,
  Mask,
  Media,
  MediaInput,
  MediaModel,
  MediaOutput,
  MediaPrice,
  ModelCapabilities,
  ModelCosts,
  ModelCostTier,
  ModelKind,
  ModelLimits,
  OperationName,
  ProviderModelDefinition,
  SegmentationPrompt,
  Track,
  TranscribeInput,
  TranscribeOptions,
  TranscribeResult,
  TranscribeSegment,
} from "./types";

/**
 * Providers are not in this entry. Each is its own subpath so a host bundles
 * only what it registers: `@foundry/models/vercel`, `/gateway`, `/fal`,
 * `/replicate`, `/claude-code`, `/codex`, and the catalog adapters behind
 * `/catalog/*`.
 */

export { modelAudit } from "./audit";
export type { CostBreakdown, CostUsageCounts } from "./cost";
export { costFromUsage } from "./cost";
export { modelErrors } from "./errors";
export type {
  AiLoggerSession,
  ModelObservabilityOptions,
  TurnObservation,
} from "./logger";
export {
  beginTurnObservation,
  configureModelObservability,
  isModelObservabilityEnabled,
  observeAgentTurn,
  recordAudit,
  SYSTEM_ACTOR,
  withAiLogger,
} from "./logger";
export type { ModelManagerOptions, ProviderPolicy } from "./manager";
export { ModelManager } from "./manager";
export type { CatalogRow, ModelOption } from "./model-option";
export { toModelOption, vendorOf } from "./model-option";
export type { KindModels, OpenOptions, Resolution } from "./resolution";
export type { ModelSelection, Route } from "./selection";
export { formatSelection } from "./selection";
