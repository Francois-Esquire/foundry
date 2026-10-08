/**
 * Session records — the durable shape of a conversation, owned by this package
 * and deliberately database-agnostic. Nothing here imports a db type: a store
 * (in-memory, drizzle, sqlite, …) projects these to/from its own rows. Inspired
 * by the database chat shape, but kept free of any backing.
 */

import type { Capability, ToolSource } from "../authorization/capability";
import type {
  HarnessActivityEvent,
  HarnessToolEvent,
} from "../harness/turn-driver";
import type { ToolEffectLocation } from "../harness/types";

export interface ToolProvenance {
  readonly agentGeneration?: number;
  readonly agentId?: string;
  readonly capability?: Capability;
  readonly effectLocation: ToolEffectLocation;
  readonly invocationId: string;
  readonly nativeId?: string;
  readonly parentToolCallId?: string;
  readonly serverId?: string;
  readonly sessionId?: string;
  readonly skillName?: string;
  readonly source: ToolSource | "external";
}

export interface ToolCallResult {
  readonly isError?: boolean;
  readonly output: unknown;
  readonly toolCallId: string;
}

export const SESSION_ROLES = [
  "user",
  "assistant",
  "system",
  "tool",
  "summary",
] as const;
/** `"summary"` is a synthetic role: a folded block standing in for earlier messages. */
export type SessionRole = (typeof SESSION_ROLES)[number];

/**
 * Discriminated union of message parts. The on-the-wire/persisted form of
 * everything emitted during a turn — not just final text. A turn streams text
 * and reasoning deltas, makes tool calls, and gets tool results; each lands as
 * a part so the full transcript is reconstructable.
 */
export type SessionPart =
  | { type: "harness_activity"; event: HarnessActivityEvent }
  | {
      type: "harness_question";
      activityId?: string;
      harness: string;
      toolCallId: string;
      questionCount: number;
      outcome: "requested" | "answered" | "declined" | "interrupted";
      answerCount?: number;
    }
  | { type: "harness_tool"; event: HarnessToolEvent }
  | { type: "harness_session"; harness: string; nativeSessionId: string }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  /** An inline image (e.g. a data URL), sent to vision-capable models. */
  | { type: "image"; url: string; mediaType?: string }
  | {
      type: "tool_call";
      toolCallId: string;
      name: string;
      input: unknown;
      /**
       * Provider metadata for the call — notably Gemini 3's `thoughtSignature`
       * (under the `google` key). Persisted and replayed verbatim: without it a
       * re-sent tool call is rejected with HTTP 400 on Gemini 3 models. Shape
       * mirrors the AI SDK `ProviderMetadata` (provider → key → value); kept
       * structural here so this persisted vocabulary stays ai-package-free.
       */
      providerOptions?: Record<string, Record<string, unknown>>;
      provenance?: ToolProvenance;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      output: unknown;
      isError?: boolean;
    }
  | { type: "error"; message: string }
  /**
   * A human decision checkpoint for a tool call, persisted so it survives
   * process restart and replay. Paired with a later `tool_approval_response`
   * by `approvalId`; see {@link "../harness/stream-transform".transformStream}
   * for where this is emitted and {@link "./converter".toModelMessages} for
   * where it's reconstructed back into an AI SDK model part.
   */
  | {
      type: "tool_approval_request";
      activityId?: string;
      /** Live callbacks resolve in process; deferred requests grant a future call.
       * Neither is an SDK replay checkpoint. Omitted on existing checkpoints. */
      approvalMode?: "live" | "deferred";
      approvalId: string;
      toolCallId: string;
      name: string;
      capability: Capability;
      input: unknown;
      signature?: string;
      agentId?: string;
      agentGeneration?: number;
    }
  /** The human's resolution for a `tool_approval_request`, matched by `approvalId`. */
  | {
      type: "tool_approval_response";
      approvalId: string;
      approved: boolean;
      scope?: "once" | "always";
      reason?: string;
    };

export interface SessionUsage {
  /** Cache-read (hit) tokens — billed at a fraction of input. */
  cachedInputTokens?: number;
  /**
   * Cache-creation (write) tokens — billed at a premium (Anthropic ~1.25×). The
   * AI SDK surfaces this on `usage.inputTokenDetails.cacheWriteTokens`; capturing
   * it is what lets a re-summarization's cache-write cost be measured.
   */
  cacheWriteTokens?: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
}

/**
 * Per-message metadata bag. Populated by turn execution (model id, usage,
 * timing); an optional, open-for-extension surface — widen as the lifecycle
 * starts writing more (cost, finishReason, error).
 */
export interface MessageMetadata {
  /** Execution environment whose native harness history this session requires. */
  harnessEnvironment?: { harness: string; id: string };
  model?: { id: string; provider?: string; harness?: string };
  /**
   * Present iff this message is a background-task notification (spec-background §0.3). Makes a
   * notification machine-identifiable — renderers and the model can tell it apart from an
   * ordinary system instruction. Carried on a `role: "system"` message (never `"user"`).
   */
  notification?: { taskId: string; kind: "status" | "completion" };
  /**
   * Caching provider options applied to this message — e.g. the Anthropic
   * `cacheControl` breakpoint set on the anchor, or the OpenAI `promptCacheKey`
   * used for the turn. Same structural shape as the AI SDK `providerOptions`
   * (provider → key → value), kept ai-package-free. Distinct from
   * `tool_call`'s own `providerOptions`, which carries Gemini's `thoughtSignature`
   * at the part level.
   */
  providerOptions?: Record<string, Record<string, unknown>>;
  timing?: { startedAt: number; completedAt: number; durationMs: number };
  usage?: SessionUsage;
}

export const MESSAGE_STATUSES = ["streaming", "complete", "error"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export interface SessionMessage {
  /** Epoch ms — kept as a number, not a Date, so the record serializes cleanly. */
  createdAt: number;
  id: string;
  metadata?: MessageMetadata;
  parts: SessionPart[];
  role: SessionRole;
  sessionId: string;
  status: MessageStatus;
  /** `true` once folded into a later `"summary"` block; excludes it from the active set. */
  summarized?: boolean;
  updatedAt: number;
}

export const SESSION_STATUSES = ["active", "archived", "error"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export interface SessionRecord {
  createdAt: number;
  id: string;
  parentMessageId?: string | null;
  /** Parent session id; absent for a root session. */
  parentSessionId?: string | null;
  /** Depth in the spawn chain, frozen at spawn (parent depth + 1). Root = 0 (absent). Never re-derived. */
  recursionDepth?: number;
  status: SessionStatus;
  title: string | null;
  updatedAt: number;
}
