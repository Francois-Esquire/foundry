import { z } from "zod";

import type { JsonValue } from "./json-value";
import { isJsonValue } from "./json-value";
import { defineOwnEntry } from "./own-entry";

const anyNumber = z.union([
  z.number(),
  z.nan(),
  z.literal([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]),
]);

const anyValue = z.unknown().default(undefined);

const counter = z.number().int().nonnegative();

function readonlyArray<T extends z.ZodType>(item: T): ReadonlyArraySchema<T> {
  return z.array(item) as unknown as ReadonlyArraySchema<T>;
}

export interface ReadonlyArraySchema<T extends z.ZodType>
  extends z.ZodType<readonly z.output<T>[], readonly z.input<T>[]> {
  readonly element: T;
}

const stringList = readonlyArray(z.string());

function recordOf<T extends z.ZodType>(entry: T) {
  return z
    .custom<Readonly<Record<string, unknown>>>(isDictionary)
    .transform((input, context) => {
      const output: Record<string, z.output<T>> = {};
      for (const key of Object.keys(input)) {
        const decoded = entry.safeParse(input[key]);
        if (decoded.success) {
          defineOwnEntry(output, key, decoded.data);
        } else {
          for (const issue of decoded.error.issues) {
            context.issues.push({
              ...issue,
              path: [key, ...issue.path],
            } as z.core.$ZodRawIssue);
          }
        }
      }
      return output;
    });
}

function isDictionary(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const unknownRecord = recordOf(z.unknown());

export const JSON_VALUE_MESSAGE = "Expected a finite, acyclic JSON value";

export const JsonValueSchema = z.custom<JsonValue>(
  isJsonValue,
  JSON_VALUE_MESSAGE
);

export const ErrorShapeSchema = z.object({
  message: z.string(),
  name: z.string(),
  stack: z.string().optional(),
});
export type ErrorShape = z.infer<typeof ErrorShapeSchema>;

export const StepStatusSchema = z.enum([
  "pending",
  "running",
  "complete",
  "failed",
  "skipped",
  "suspended",
  "aborted",
  "paused",
]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

const workflowStepNodeFields = {
  index: anyNumber,
  key: z.string(),
  name: z.string(),
};

export type WorkflowStepNode = z.infer<
  z.ZodObject<typeof workflowStepNodeFields>
> & {
  readonly children?: readonly WorkflowStepNode[];
};

export interface WorkflowStepNodeShape
  extends Readonly<typeof workflowStepNodeFields> {
  readonly children: z.ZodOptional<
    ReadonlyArraySchema<WorkflowStepNodeObjectSchema>
  >;
}

export interface WorkflowStepNodeObjectSchema
  extends z.ZodType<WorkflowStepNode> {
  readonly shape: WorkflowStepNodeShape;
}

export const WorkflowStepNodeSchema: WorkflowStepNodeObjectSchema = z.object({
  get children() {
    return readonlyArray(WorkflowStepNodeSchema).optional();
  },
  ...workflowStepNodeFields,
});

export const WorkflowSnapshotSchema = z.object({
  cursor: z.string().nullable(),
  input: anyValue,
  name: z.string(),
  steps: readonlyArray(WorkflowStepNodeSchema),
});
export type WorkflowSnapshot = z.infer<typeof WorkflowSnapshotSchema>;

export const StepSnapshotSchema = z.object({
  attempt: anyNumber,
  bail: z.unknown().optional(),
  completedAt: z.string().optional(),
  durationMs: anyNumber.optional(),
  error: ErrorShapeSchema.optional(),
  name: z.string(),
  namespace: z.string(),
  output: z.unknown().optional(),
  progress: anyNumber.optional(),
  startedAt: z.string().optional(),
  status: StepStatusSchema,
  suspendedAt: z.string().optional(),
  suspension: z
    .object({
      correlationId: z.string().optional(),
      meta: unknownRecord.optional(),
      name: z.string(),
      reason: z.string(),
      suspendedAt: z.string(),
    })
    .optional(),
});
export type StepSnapshot = z.infer<typeof StepSnapshotSchema>;

export const SnapshotStateSchema = z.object({
  results: unknownRecord,
  steps: recordOf(StepSnapshotSchema),
  updatedAt: z.string(),
  workflow: WorkflowSnapshotSchema.nullable(),
});
export type SnapshotState = z.infer<typeof SnapshotStateSchema>;

export const SuspensionStateSchema = z.object({
  correlationId: z.string().optional(),
  kind: z.string().optional(),
  meta: unknownRecord.optional(),
  name: z.string(),
  occurrence: counter.optional(),
  reason: z.string(),
  request: z.unknown().optional(),
  stepPath: stringList.optional(),
  suspendedAt: z.string(),
});
export type SuspensionState = z.infer<typeof SuspensionStateSchema>;

const lifecycleFields = {
  at: z.string(),
  attempt: anyNumber,
  name: z.string(),
  path: stringList,
};

export const StepStartedEvent = z.object({
  _tag: z.literal("step.started"),
  ...lifecycleFields,
});
export const StepCompleteEvent = z.object({
  _tag: z.literal("step.complete"),
  ...lifecycleFields,
  value: anyValue,
});
export const StepFailedEvent = z.object({
  _tag: z.literal("step.failed"),
  ...lifecycleFields,
  error: ErrorShapeSchema,
});
export const StepBailedEvent = z.object({
  _tag: z.literal("step.bailed"),
  ...lifecycleFields,
  bail: anyValue,
});
export const StepSuspendedEvent = z.object({
  _tag: z.literal("step.suspended"),
  ...lifecycleFields,
  suspension: SuspensionStateSchema,
});
export const StepPausedEvent = z.object({
  _tag: z.literal("step.paused"),
  ...lifecycleFields,
  reason: z.string().optional(),
});
export const StepResumedEvent = z.object({
  _tag: z.literal("step.resumed"),
  ...lifecycleFields,
});
export const StepSkippedEvent = z.object({
  _tag: z.literal("step.skipped"),
  ...lifecycleFields,
  reason: z.string().optional(),
});
export const StepAbortedEvent = z.object({
  _tag: z.literal("step.aborted"),
  ...lifecycleFields,
  reason: z.unknown().optional(),
});
export const StepProgressEvent = z.object({
  _tag: z.literal("step.progress"),
  ...lifecycleFields,
  value: anyNumber,
});
export const StepResolvedEvent = z.object({
  _tag: z.literal("step.resolved"),
  ...lifecycleFields,
  suspensionName: z.string(),
  value: anyValue,
});
export const CustomEvent = z.object({
  _tag: z.literal("custom"),
  at: z.string(),
  path: stringList,
  payload: z.unknown().optional(),
  stepId: z.string(),
  type: z.string(),
});

export const ChannelEventSchema = z.discriminatedUnion("_tag", [
  StepStartedEvent,
  StepCompleteEvent,
  StepFailedEvent,
  StepBailedEvent,
  StepSuspendedEvent,
  StepPausedEvent,
  StepResumedEvent,
  StepSkippedEvent,
  StepAbortedEvent,
  StepResolvedEvent,
  StepProgressEvent,
  CustomEvent,
]);
export type ChannelEvent = z.infer<typeof ChannelEventSchema>;

export const WorkflowTelemetrySchema = z.object({
  logs: readonlyArray(
    z.object({
      at: z.string(),
      level: z.enum(["debug", "info", "warn", "error"]),
      message: z.string(),
      metadata: unknownRecord.optional(),
      path: stringList.optional(),
      stepId: z.string().optional(),
    })
  ),
  metrics: z.object({
    updatedAt: z.string(),
    values: recordOf(anyNumber),
  }),
});
