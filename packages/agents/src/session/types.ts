/**
 * Session records — the durable shape of a conversation, owned by this package
 * and deliberately database-agnostic. Nothing here imports a db type: a store
 * (in-memory, drizzle, sqlite, …) projects these to/from its own rows. Inspired
 * by the database chat shape, but kept free of any backing.
 */

import type { Capability, ToolSource } from "../authorization";
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

/** `"summary"` is a synthetic role: a folded block standing in for earlier messages. */
export type SessionRole = "user" | "assistant" | "system" | "tool" | "summary";

/**
 * Discriminated union of message parts. The on-the-wire/persisted form of
 * everything emitted during a turn — not just final text. A turn streams text
 * and reasoning deltas, makes tool calls, and gets tool results; each lands as
 * a part so the full transcript is reconstructable.
 */
export type SessionPart =
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
      approvalId: string;
      toolCallId: string;
      name: string;
      capability: Capability;
      input: unknown;
      signature?: string;
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

export type MessageStatus = "streaming" | "complete" | "error";

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

export type SessionStatus = "active" | "archived" | "error";

export interface SessionRecord {
  createdAt: number;
  id: string;
  /** The invoking message id in the parent that spawned this session. */
  parentMessageId?: string | null;
  /** Parent session id — non-null marks this session as a spawned sub-agent (ruling 0007). Root = null/absent. */
  parentSessionId?: string | null;
  /** Depth in the spawn chain, frozen at spawn (parent depth + 1). Root = 0 (absent). Never re-derived. */
  recursionDepth?: number;
  status: SessionStatus;
  title: string | null;
  updatedAt: number;
}
