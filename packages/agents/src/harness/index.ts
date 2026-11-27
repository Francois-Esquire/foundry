// biome-ignore-all lint/performance/noBarrelFile: This is the exported @foundry/agents/harness public API.
export type {
  AgentModel,
  HarnessActivity,
  HarnessActivityEvent,
  HarnessCapabilities,
  HarnessPermissionCallback,
  HarnessPermissionProfile,
  HarnessPermissionRequest,
  HarnessPermissionResult,
  HarnessQuestion,
  HarnessQuestionCallback,
  HarnessQuestionRequest,
  HarnessQuestionResult,
  HarnessResponseFormat,
  HarnessToolEvent,
  HarnessTurnDriver,
  ModelLimits,
  ModelRoute,
  ObserveTurn,
  TurnObservation,
} from "@foundry/core/agents";
export { validateHarnessProfile } from "@foundry/core/agents";
export {
  createHarnessActivityRecorder,
  reduceHarnessActivities,
} from "./activity";
export type { AgentHarnessSettings } from "./agent-harness";
export { AgentHarness } from "./agent-harness";
export type { BuiltinCodingSettings } from "./builtin-coding";
export {
  CODING_INSTRUCTIONS,
  createBuiltinCodingHarness,
} from "./builtin-coding";
export { composeTools } from "./compose-tools";
export { createDriverSession } from "./driver-session";
export type {
  DriverSessionSettings,
  HarnessAuthoritySettings,
  HarnessSession,
} from "./harness-session";
export type {
  LoopAgent,
  TurnCallSettings,
  TurnContext,
  TurnSettings,
} from "./loop-agent";
export {
  createHarnessPermission,
  redactHarnessSummary,
  resolveHarnessApproval,
  summarizeHarnessInput,
} from "./permission";
export type { HarnessQuestionToolSettings } from "./question";
export { createHarnessQuestionTool, isHarnessQuestionTool } from "./question";
export type {
  CompactionSettings,
  SessionHarnessSettings,
  TurnOptions,
} from "./session-harness";
export { SessionHarness } from "./session-harness";
export type {
  HarnessStreamPart,
  StreamPart,
  StreamSource,
  TransformOptions,
} from "./stream-transform";
export { transformStream } from "./stream-transform";
export type { ToolAuthorizationContext } from "./tool-compiler";
export {
  compileTools,
  isPolicyDeniedOutput,
  registerToolCall,
  toolAuthorizationContext,
  toolAuthorizationRequest,
} from "./tool-compiler";
export type {
  AgentInvocationContext,
  RegisteredToolCall,
  ToolEffectLocation,
  ToolMeta,
} from "./tool-registration";
export {
  metaOf,
  TOOL_META,
  tagTool,
  tagTools,
} from "./tool-registration";
