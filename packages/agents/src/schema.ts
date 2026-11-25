import type {
  HarnessActivity as CoreHarnessActivity,
  HarnessActivityEvent as CoreHarnessActivityEvent,
  HarnessToolEvent as CoreHarnessToolEvent,
  SessionPart as CoreSessionPart,
  ToolEffectLocation as CoreToolEffectLocation,
  ToolProvenance as CoreToolProvenance,
} from "@foundry/core/agents";
import { z } from "zod";

import { capabilitySchema, toolSourceSchema } from "./authorization/schema";

const recordId = z.string().min(1);

const epochMs = z.int().nonnegative();

const count = z.int().nonnegative();

const providerOptionsSchema = z.record(
  z.string(),
  z.record(z.string(), z.unknown())
);

export const toolEffectLocationSchema = z.enum(["runtime", "host", "executor"]);
export type ToolEffectLocation = z.infer<typeof toolEffectLocationSchema>;

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

export const harnessActivityEventSchema = harnessActivitySchema.extend({
  agentId: z.string(),
  harness: z.string(),
  revision: z.int().positive(),
  sessionId: recordId,
});
export type HarnessActivityEvent = z.infer<typeof harnessActivityEventSchema>;

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
  z.object({
    mediaType: z.string().optional(),
    type: z.literal("image"),
    url: z.string(),
  }),
  z.object({
    input: z.unknown().optional(),
    name: z.string(),
    provenance: toolProvenanceSchema.optional(),
    providerOptions: providerOptionsSchema.optional(),
    toolCallId: z.string(),
    type: z.literal("tool_call"),
  }),
  z.object({
    isError: z.boolean().optional(),
    output: z.unknown().optional(),
    toolCallId: z.string(),
    type: z.literal("tool_result"),
  }),
  z.object({ message: z.string(), type: z.literal("error") }),
  z.object({
    activityId: z.string().optional(),
    agentGeneration: count.optional(),
    agentId: z.string().optional(),
    approvalId: z.string(),
    approvalMode: z.enum(["live", "deferred"]).optional(),
    capability: capabilitySchema,
    input: z.unknown().optional(),
    name: z.string(),
    signature: z.string().optional(),
    toolCallId: z.string(),
    type: z.literal("tool_approval_request"),
  }),
  z.object({
    approvalId: z.string(),
    approved: z.boolean(),
    granted: z.boolean().optional(),
    reason: z.string().optional(),
    scope: z.enum(["once", "always"]).optional(),
    type: z.literal("tool_approval_response"),
  }),
]);
export type SessionPart = z.infer<typeof sessionPartSchema>;

export const SESSION_ROLES = [
  "user",
  "assistant",
  "system",
  "tool",
  "summary",
] as const;
export const sessionRoleSchema = z.enum(SESSION_ROLES);
export type SessionRole = z.infer<typeof sessionRoleSchema>;

export const MESSAGE_STATUSES = ["streaming", "complete", "error"] as const;
export const messageStatusSchema = z.enum(MESSAGE_STATUSES);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

export const sessionUsageSchema = z.object({
  cachedInputTokens: count.optional(),
  cacheWriteTokens: count.optional(),
  inputTokens: count,
  outputTokens: count,
  reasoningTokens: count.optional(),
  totalTokens: count,
});
export type SessionUsage = z.infer<typeof sessionUsageSchema>;

export const messageMetadataSchema = z.object({
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
  notification: z
    .object({ kind: z.enum(["status", "completion"]), taskId: z.string() })
    .optional(),
  output: z.unknown().optional(),
  providerOptions: providerOptionsSchema.optional(),
  timing: z
    .object({
      completedAt: epochMs,
      durationMs: z.int(),
      startedAt: epochMs,
    })
    .optional(),
  usage: sessionUsageSchema.optional(),
});
export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

export const sessionMessageSchema = z.object({
  createdAt: epochMs,
  id: recordId,
  metadata: messageMetadataSchema.optional(),
  parts: z.array(sessionPartSchema),
  role: sessionRoleSchema,
  sessionId: recordId,
  status: messageStatusSchema,
  summarized: z.boolean().optional(),
  updatedAt: epochMs,
});
export type SessionMessage = z.infer<typeof sessionMessageSchema>;

export const SESSION_STATUSES = ["active", "archived", "error"] as const;
export const sessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const sessionRecordSchema = z.object({
  createdAt: epochMs,
  id: recordId,
  parentMessageId: recordId.nullable().optional(),
  parentSessionId: recordId.nullable().optional(),
  recursionDepth: count.optional(),
  status: sessionStatusSchema,
  title: z.string().nullable(),
  updatedAt: epochMs,
});
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

export const summarySchema = z.object({
  digestText: z.string(),
  subjectSessionId: recordId,
});
export type Summary = z.infer<typeof summarySchema>;

const changeEventFields = {
  at: z.iso.datetime(),
  id: recordId,
  sessionId: recordId,
};

export const sessionChangeEventSchema = z.discriminatedUnion("type", [
  z.object({ ...changeEventFields, type: z.literal("session.created") }),
  z.object({ ...changeEventFields, type: z.literal("session.updated") }),
  z.object({
    ...changeEventFields,
    messageIds: z.array(recordId).min(1),
    type: z.literal("session.messages.appended"),
  }),
]);
export type SessionChangeEvent = z.infer<typeof sessionChangeEventSchema>;

type AssertEqual<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

type AssertAllTrue<Checks extends readonly true[]> = Checks;

type _CoreAgentContracts = AssertAllTrue<
  [
    AssertEqual<ToolEffectLocation, CoreToolEffectLocation>,
    AssertEqual<HarnessActivity, CoreHarnessActivity>,
    AssertEqual<HarnessActivityEvent, CoreHarnessActivityEvent>,
    AssertEqual<HarnessToolEvent, CoreHarnessToolEvent>,
    AssertEqual<ToolProvenance, CoreToolProvenance>,
    AssertEqual<SessionPart, CoreSessionPart>,
  ]
>;
