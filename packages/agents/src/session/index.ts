// biome-ignore-all lint/performance/noBarrelFile: This is the exported @foundry/agents/session public API.

export type {
  MessageMetadata,
  MessageStatus,
  SessionChangeEvent,
  SessionMessage,
  SessionPart,
  SessionRecord,
  SessionRole,
  SessionStatus,
  SessionUsage,
  ToolProvenance,
} from "../schema";
export {
  MESSAGE_STATUSES,
  SESSION_ROLES,
  SESSION_STATUSES,
} from "../schema";
export type {
  CompactionOptions,
  ModelSummarizerOptions,
  Summarizer,
} from "./compactor";
export {
  compact,
  createModelSummarizer,
  maybeCompact,
  renderTranscript,
  selectMarker,
} from "./compactor";
export { toModelMessages } from "./converter";
export type {
  AgentApprovalRequest,
  AgentApprovalResponse,
  SessionEvent,
  SessionInput,
  SessionStream,
  SessionTurnOutcome,
  StreamHandlers,
  ToolCallResult,
} from "./events";
export type { RawMessageMetadata, RawUsage } from "./metadata";
export { normalizeMessageMetadata } from "./metadata";
export type {
  CreateMessageInput,
  CreateSessionInput,
  SessionsOptions,
  SummarizeInput,
  SummarizeResult,
  UpdateMessageInput,
  UpdateSessionInput,
} from "./sessions";
export { foldSet, messagesToSummarize, Sessions } from "./sessions";
