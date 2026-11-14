/**
 * Session vocabulary. The persisted records are defined once, as schemas, in
 * `../schema`; their types are re-exported here under the names this module
 * has always exported.
 */

export type {
  MessageMetadata,
  MessageStatus,
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
