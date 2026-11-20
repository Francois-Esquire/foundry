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

export interface ToolCallResult {
  readonly isError?: boolean;
  readonly output: unknown;
  readonly toolCallId: string;
}
