/**
 * The AI SDK model contract our providers hand back. Re-exported so hosts can
 * type a custom provider without depending on the SDK's provider spec package.
 */
export type { LanguageModelV4, ProviderV4 } from "@ai-sdk/provider";
/** Live access shapes only; the interaction itself is not in this entry. */
export type { LiveAccess, LiveTarget } from "./live/types";
/**
 * Only the on-device *surface* lives here. The runtime (`LocalProvider`, the
 * worker bridge, `configureCache`) is behind `@foundry/models/local` so that
 * importing the registry never loads transformers-js.
 */
export type {
  LocalDownloadProgress,
  LocalFileProgress,
  LocalLoadedModel,
  LocalLoadState,
  LocalLoadStatus,
  LocalModelDefinition,
  LocalProviderSurface,
} from "./local/surface";
export { isLocalProvider } from "./local/surface";
export type {
  LanguageModelOptions,
  ModelManagerCredentials,
  Provider,
  ProviderBinding,
} from "./provider";
export {
  fromSdk,
  operationsOf,
  resolveDefinition,
  servesKind,
} from "./provider";
export type {
  CapabilityFact,
  DeliveryForm,
  InputForm,
  InteractionMode,
  KindDefault,
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
  Offer,
  OperationName,
  ProviderModelDefinition,
  SegmentationPrompt,
  Selection,
  Track,
  TranscribeInput,
  TranscribeOptions,
  TranscribeResult,
  TranscribeSegment,
} from "./types";

/**
 * Providers are not in this entry. Each is its own subpath so a host bundles
 * only what it registers: `@foundry/models/vercel`, `/gateway`, `/fal`,
 * `/replicate`, `/claude-code`, `/codex`, and the bundled catalog snapshots
 * behind `/catalog`.
 */

export { modelAudit } from "./audit";
export type {
  AgentConfigEvents,
  AgentConfigType,
  AgentConfigTypeKey,
} from "./config";

export { AgentConfig } from "./config";
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
export type {
  BootstrapOptions,
  ModelManagerOptions,
  ModelSelectionOptions,
  OperationSelectionOptions,
  TurnExecutorRef,
} from "./manager";
export { ModelManager } from "./manager";
export type { CatalogRow, ModelOption } from "./model-option";
export { STUDIO_HARNESS, toModelOption, vendorOf } from "./model-option";
