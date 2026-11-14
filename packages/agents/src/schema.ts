/**
 * The persisted records of this package: the single definition of every shape
 * a session store keeps or returns. Each type is inferred from its schema, so a
 * store (in-memory, JSON file, SQLite, …) can derive its table or file layout
 * from these and never restate them.
 *
 * Database-agnostic on purpose: nothing here imports a db type. A store
 * projects these to and from its own rows.
 *
 * Nothing parses through these schemas yet; they describe the shape for the
 * stores that will. The capability and tool-source vocabulary embedded in tool
 * parts is owned by `./authorization/schema` and reused here as is.
 */

import { z } from "zod";

import { capabilitySchema, toolSourceSchema } from "./authorization/schema";

/** A record id: a session, message or harness-native id. Never empty. */
const recordId = z.string().min(1);

/** Epoch milliseconds — kept as a number, not a Date, so a record serializes cleanly. */
const epochMs = z.int().nonnegative();

/** A token or item count. */
const count = z.int().nonnegative();

/**
 * Provider options in the AI SDK `ProviderMetadata` shape (provider → key →
 * value), kept structural so this vocabulary stays ai-package-free.
 */
const providerOptionsSchema = z.record(
  z.string(),
  z.record(z.string(), z.unknown())
);

// ---------------------------------------------------------------------------
// Harness events, persisted verbatim inside message parts.
// ---------------------------------------------------------------------------

/** Where an approved tool effect runs. */
export const toolEffectLocationSchema = z.enum(["runtime", "host", "executor"]);
export type ToolEffectLocation = z.infer<typeof toolEffectLocationSchema>;

/**
 * One background activity a CLI harness reports (a sub-agent, task, watch or
 * schedule). Full snapshots, with ids scoped to the native process/environment
 * generation. Completion of the parent turn says nothing about these activities.
 */
export const harnessActivitySchema = z.object({
  actions: z.array(z.literal("stop")).readonly().optional(),
  id: recordId,
  kind: z.enum(["subagent", "task", "watch", "schedule"]),
  lifetime: z.enum(["session", "sandbox"]),
  nativeId: z.string().optional(),
  parentId: z.string().optional(),
  status: z.enum([
    "running",
    "waiting",
    "complete",
    "failed",
    "cancelled",
    "unknown",
  ]),
  summary: z.string().optional(),
  title: z.string(),
});
export type HarnessActivity = z.infer<typeof harnessActivitySchema>;

/** A {@link HarnessActivity} stamped with who reported it and its revision. */
export const harnessActivityEventSchema = harnessActivitySchema.extend({
  agentId: z.string(),
  harness: z.string(),
  /** Increases by one per report of the same activity; the highest wins. */
  revision: z.int().positive(),
  sessionId: recordId,
});
export type HarnessActivityEvent = z.infer<typeof harnessActivityEventSchema>;

/** One tool call a CLI harness ran in its own loop. */
export const harnessToolEventSchema = z.object({
  activityId: z.string().optional(),
  agentId: z.string(),
  harness: z.string(),
  inputSummary: z.string(),
  outcome: z.enum(["started", "ran", "refused", "failed"]),
  reason: z.string().optional(),
  sessionId: recordId,
  toolCallId: z.string(),
  toolName: z.string(),
});
export type HarnessToolEvent = z.infer<typeof harnessToolEventSchema>;

// ---------------------------------------------------------------------------
// Message parts.
// ---------------------------------------------------------------------------

/** Who registered a tool call and where its effect runs, persisted on the call. */
export const toolProvenanceSchema = z
  .object({
    agentGeneration: count.optional(),
    agentId: z.string().optional(),
    capability: capabilitySchema.optional(),
    effectLocation: toolEffectLocationSchema,
    invocationId: z.string(),
    nativeId: z.string().optional(),
    parentToolCallId: z.string().optional(),
    serverId: z.string().optional(),
    sessionId: recordId.optional(),
    skillName: z.string().optional(),
    source: z.union([toolSourceSchema, z.literal("external")]),
  })
  .readonly();
export type ToolProvenance = z.infer<typeof toolProvenanceSchema>;

/**
 * One part of a message: the persisted form of everything emitted during a
 * turn, not just final text. A turn streams text and reasoning deltas, makes
 * tool calls, and gets tool results; each lands as a part so the full
 * transcript is reconstructable.
 */
export const sessionPartSchema = z.discriminatedUnion("type", [
  z.object({
    event: harnessActivityEventSchema,
    type: z.literal("harness_activity"),
  }),
  z.object({
    activityId: z.string().optional(),
    answerCount: count.optional(),
    harness: z.string(),
    outcome: z.enum(["requested", "answered", "declined", "interrupted"]),
    questionCount: count,
    toolCallId: z.string(),
    type: z.literal("harness_question"),
  }),
  z.object({ event: harnessToolEventSchema, type: z.literal("harness_tool") }),
  z.object({
    harness: z.string(),
    nativeSessionId: z.string(),
    type: z.literal("harness_session"),
  }),
  z.object({ text: z.string(), type: z.literal("text") }),
  z.object({ text: z.string(), type: z.literal("reasoning") }),
  /** An inline image (e.g. a data URL), sent to vision-capable models. */
  z.object({
    mediaType: z.string().optional(),
    type: z.literal("image"),
    url: z.string(),
  }),
  z.object({
    input: z.unknown(),
    name: z.string(),
    provenance: toolProvenanceSchema.optional(),
    /**
     * Provider metadata for the call — notably Gemini 3's `thoughtSignature`
     * (under the `google` key). Persisted and replayed verbatim: without it a
     * re-sent tool call is rejected with HTTP 400 on Gemini 3 models.
     */
    providerOptions: providerOptionsSchema.optional(),
    toolCallId: z.string(),
    type: z.literal("tool_call"),
  }),
  z.object({
    isError: z.boolean().optional(),
    output: z.unknown(),
    toolCallId: z.string(),
    type: z.literal("tool_result"),
  }),
  z.object({ message: z.string(), type: z.literal("error") }),
  /**
   * A human decision checkpoint for a tool call, persisted so it survives
   * process restart and replay. Paired with a later `tool_approval_response`
   * by `approvalId`; emitted by the harness stream transform and rebuilt into
   * an AI SDK model part by the session converter.
   */
  z.object({
    activityId: z.string().optional(),
    agentGeneration: count.optional(),
    agentId: z.string().optional(),
    approvalId: z.string(),
    /**
     * Live callbacks resolve in process; deferred requests grant a future call.
     * Neither is an SDK replay checkpoint. Omitted on existing checkpoints.
     */
    approvalMode: z.enum(["live", "deferred"]).optional(),
    capability: capabilitySchema,
    input: z.unknown(),
    name: z.string(),
    signature: z.string().optional(),
    toolCallId: z.string(),
    type: z.literal("tool_approval_request"),
  }),
  /** The human's resolution for a `tool_approval_request`, matched by `approvalId`. */
  z.object({
    approvalId: z.string(),
    approved: z.boolean(),
    reason: z.string().optional(),
    scope: z.enum(["once", "always"]).optional(),
    type: z.literal("tool_approval_response"),
  }),
]);
export type SessionPart = z.infer<typeof sessionPartSchema>;

// ---------------------------------------------------------------------------
// Messages.
// ---------------------------------------------------------------------------

export const SESSION_ROLES = [
  "user",
  "assistant",
  "system",
  "tool",
  "summary",
] as const;
/** `"summary"` is a synthetic role: a folded block standing in for earlier messages. */
export const sessionRoleSchema = z.enum(SESSION_ROLES);
export type SessionRole = z.infer<typeof sessionRoleSchema>;

export const MESSAGE_STATUSES = ["streaming", "complete", "error"] as const;
export const messageStatusSchema = z.enum(MESSAGE_STATUSES);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

/** Token usage of one turn. */
export const sessionUsageSchema = z.object({
  /** Cache-read (hit) tokens — billed at a fraction of input. */
  cachedInputTokens: count.optional(),
  /**
   * Cache-creation (write) tokens — billed at a premium (Anthropic ~1.25×). The
   * AI SDK surfaces this on `usage.inputTokenDetails.cacheWriteTokens`; capturing
   * it is what lets a re-summarization's cache-write cost be measured.
   */
  cacheWriteTokens: count.optional(),
  inputTokens: count,
  outputTokens: count,
  reasoningTokens: count.optional(),
  totalTokens: count,
});
export type SessionUsage = z.infer<typeof sessionUsageSchema>;

/**
 * Per-message metadata. Populated by turn execution (model id, usage, timing);
 * open for extension — widen as the lifecycle starts writing more (cost,
 * finishReason, error).
 */
export const messageMetadataSchema = z.object({
  /** Execution environment whose native harness history this session requires. */
  harnessEnvironment: z
    .object({ harness: z.string(), id: z.string() })
    .optional(),
  model: z
    .object({
      harness: z.string().optional(),
      id: z.string(),
      provider: z.string().optional(),
    })
    .optional(),
  /**
   * Present iff this message is a background-task notification. Makes a
   * notification machine-identifiable — renderers and the model can tell it
   * apart from an ordinary system instruction. Carried on a `role: "system"`
   * message (never `"user"`).
   */
  notification: z
    .object({ kind: z.enum(["status", "completion"]), taskId: z.string() })
    .optional(),
  /**
   * The structured value a turn with an `output` parsed from its final text,
   * kept so a reloaded or replayed message returns it without parsing again.
   */
  output: z.unknown().optional(),
  /**
   * Caching provider options applied to this message — e.g. the Anthropic
   * `cacheControl` breakpoint set on the anchor, or the OpenAI `promptCacheKey`
   * used for the turn. Distinct from `tool_call`'s own `providerOptions`, which
   * carries Gemini's `thoughtSignature` at the part level.
   */
  providerOptions: providerOptionsSchema.optional(),
  timing: z
    .object({
      completedAt: epochMs,
      /** `completedAt - startedAt`; wall-clock, so not guaranteed non-negative. */
      durationMs: z.int(),
      startedAt: epochMs,
    })
    .optional(),
  usage: sessionUsageSchema.optional(),
});
export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

/** One message of a session, in the order the store appended it. */
export const sessionMessageSchema = z.object({
  createdAt: epochMs,
  id: recordId,
  metadata: messageMetadataSchema.optional(),
  parts: z.array(sessionPartSchema),
  role: sessionRoleSchema,
  sessionId: recordId,
  status: messageStatusSchema,
  /** `true` once folded into a later `"summary"` block; excludes it from the active set. */
  summarized: z.boolean().optional(),
  updatedAt: epochMs,
});
export type SessionMessage = z.infer<typeof sessionMessageSchema>;

// ---------------------------------------------------------------------------
// Sessions.
// ---------------------------------------------------------------------------

export const SESSION_STATUSES = ["active", "archived", "error"] as const;
export const sessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

/** One conversation. Its messages are kept apart and reference it by `sessionId`. */
export const sessionRecordSchema = z.object({
  createdAt: epochMs,
  id: recordId,
  /** The parent session's message that spawned this one; null or absent for a root session. */
  parentMessageId: recordId.nullable().optional(),
  /** Parent session id; null or absent for a root session. */
  parentSessionId: recordId.nullable().optional(),
  /** Depth in the spawn chain, frozen at spawn (parent depth + 1). Root = 0 (absent). Never re-derived. */
  recursionDepth: count.optional(),
  status: sessionStatusSchema,
  title: z.string().nullable(),
  updatedAt: epochMs,
});
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

/** A cross-session digest. Subject = exactly one session; digest-shaped, NOT a fact-memory. */
export const summarySchema = z.object({
  digestText: z.string(),
  subjectSessionId: recordId,
});
export type Summary = z.infer<typeof summarySchema>;
