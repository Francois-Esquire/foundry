import type { JsonValue } from "@foundry/lib/json";
import type { ProcessIdentity } from "@foundry/lib/process-identity";
import type { Job, Links, Run } from "@foundry/queue";
import { z } from "zod";
import type { ExecutionStatus } from "./execution-statuses";

export const DEFAULT_QUEUE = "marbles";

const TASK_TAG = "marbles.kind";

export interface ExecutionUsage {
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly source: "provider";
  readonly totalTokens?: number;
}

export type ObservationStatus =
  | "running"
  | "complete"
  | "failed"
  | "denied"
  | "cancelled";

interface ObservationBase {
  readonly endedAt?: string;
  readonly errorCode?: string;
  readonly id: string;
  readonly startedAt: string;
  readonly status: ObservationStatus;
}

export interface ModelTurnObservation extends ObservationBase {
  readonly kind: "model-turn";
  readonly model: string;
  readonly provider?: string;
  readonly sessionId: string;
  readonly usage?: ExecutionUsage;
}

export interface ToolCallObservation extends ObservationBase {
  readonly kind: "tool-call";
  readonly name: string;
  readonly sessionId: string;
}

export interface HostObservation extends ObservationBase {
  readonly data?: JsonValue;
  readonly kind: "effect" | "result";
  readonly type: string;
}

export type ExecutionObservation =
  | ModelTurnObservation
  | ToolCallObservation
  | HostObservation;

export interface ExecutionRun {
  readonly correlation: Readonly<Record<string, string>>;
  readonly error?: { readonly code: string; readonly message?: string };
  readonly id: string;
  readonly input?: JsonValue;
  readonly jobId: string;
  readonly kind: "workflow" | "task";
  readonly name: string;
  readonly observations: readonly ExecutionObservation[];
  readonly owner?: ProcessIdentity;
  readonly progress?: JsonValue;
  readonly queue: string;
  readonly revision: number;
  readonly sequence: number;
  readonly source?: string;
  readonly status: ExecutionStatus;
  readonly timestamps: {
    readonly queuedAt: string;
    readonly settledAt?: string;
    readonly startedAt?: string;
    readonly updatedAt: string;
  };
}

export interface QueueSettings {
  readonly concurrency: number;
}

export interface QueueState extends QueueSettings {
  readonly active: number;
  readonly name: string;
  readonly waiting: number;
}

export interface RetentionGap {
  readonly removed: number;
  readonly scope: string;
  readonly through: string;
  readonly updatedAt: string;
}

export interface ExecutionSubscription {
  readonly snapshot: readonly ExecutionRun[];
  unsubscribe(): void;
}

export interface ExecutionRuns {
  configure(queue: string, settings: QueueSettings): void;
  gaps(): readonly RetentionGap[];
  get(id: string): ExecutionRun | undefined;
  list(): readonly ExecutionRun[];
  peek(id: string): Promise<ExecutionRun | undefined>;
  prune(
    ids: Iterable<string>,
    scopeOf: (run: ExecutionRun) => string
  ): Promise<readonly ExecutionRun[]>;
  queues(): readonly QueueState[];
  subscribe(
    listener: (run: ExecutionRun) => void
  ): Promise<ExecutionSubscription>;
}

export interface ExecutionAnnex {
  readonly id: string;
  readonly observations: readonly ExecutionObservation[];
  readonly progress?: JsonValue;
  readonly revision: number;
  readonly updatedAt?: string;
}

export interface StoredAnnex {
  readonly id: string;
  readonly observations: readonly unknown[];
  readonly progress?: unknown;
  readonly revision: number;
  readonly updatedAt?: string;
}

const iso = (at: number): string => new Date(at).toISOString();

export function now(): string {
  return new Date().toISOString();
}

export function isTask(job: Pick<Job, "links">): boolean {
  return job.links.tags?.[TASK_TAG] === "task";
}

export function linksOf(options: {
  readonly correlation?: Readonly<Record<string, string>>;
  readonly kind: ExecutionRun["kind"];
  readonly parentRunId?: Links["parentRunId"];
  readonly source?: string;
  readonly triggerId?: string;
}): Links {
  const { triggerId, ...correlation } = options.correlation ?? {};
  const trigger: string | undefined = options.triggerId ?? triggerId;
  const tags = {
    ...correlation,
    ...(options.kind === "task" ? { [TASK_TAG]: "task" } : {}),
  };
  return {
    ...(options.parentRunId === undefined
      ? {}
      : { parentRunId: options.parentRunId }),
    ...(options.source === undefined ? {} : { source: options.source }),
    ...(Object.keys(tags).length === 0 ? {} : { tags }),
    ...(trigger === undefined ? {} : { triggerId: trigger }),
  };
}

function tagsOf(links: Links): Readonly<Record<string, string>> | undefined {
  if (links.tags === undefined || !(TASK_TAG in links.tags)) {
    return links.tags;
  }
  const { [TASK_TAG]: _kind, ...tags } = links.tags;
  return tags;
}

function statusOf(run: Run): ExecutionStatus {
  return run.state.kind;
}

function errorOf(run: Run): ExecutionRun["error"] {
  if (run.state.kind === "interrupted") {
    return { code: "interrupted", message: run.state.reason };
  }
  if (run.state.kind !== "failed") {
    return;
  }
  const { message, name } = run.state.error;
  return message === "" ? { code: name } : { code: name, message };
}

function settledAtOf(run: Run): number | undefined {
  switch (run.state.kind) {
    case "complete":
      return run.state.completedAt;
    case "failed":
      return run.state.failedAt;
    case "cancelled":
      return run.state.cancelledAt;
    case "interrupted":
      return run.state.interruptedAt;
    default:
      return;
  }
}

export function ownerOfRun(run: Run): ProcessIdentity | undefined {
  switch (run.state.kind) {
    case "running":
      return identityOf(run.state.lease.owner);
    case "queued":
      return run.state.owner && identityOf(run.state.owner);
    default:
      return;
  }
}

function identityOf(owner: ProcessIdentity): ProcessIdentity {
  return { pid: owner.pid, started: owner.started };
}

function changedAt(run: Run): number | undefined {
  switch (run.state.kind) {
    case "queued":
      return run.state.queuedAt;
    case "running":
      return run.state.lease.claimedAt;
    case "suspended":
      return run.state.suspendedAt;
    default:
      return;
  }
}

export function executionOf(
  job: Job,
  run: Run,
  annex?: ExecutionAnnex
): ExecutionRun {
  const status = statusOf(run);
  const error = errorOf(run);
  const owner = ownerOfRun(run);
  const settledAt = settledAtOf(run);
  const latest = Math.max(
    job.createdAt,
    run.startedAt ?? 0,
    changedAt(run) ?? 0,
    settledAt ?? 0
  );
  const updatedAt =
    annex?.updatedAt !== undefined && annex.updatedAt > iso(latest)
      ? annex.updatedAt
      : iso(latest);
  const { links } = job;
  return {
    correlation: {
      ...tagsOf(links),
      ...(links.triggerId === undefined ? {} : { triggerId: links.triggerId }),
    },
    ...(error === undefined ? {} : { error }),
    id: run.id,
    ...(status === "queued" ? { input: job.input } : {}),
    jobId: job.id,
    kind: isTask(job) ? "task" : "workflow",
    name: job.handler.name,
    observations: annex?.observations ?? [],
    ...(owner === undefined ? {} : { owner }),
    ...(annex?.progress === undefined ? {} : { progress: annex.progress }),
    queue: job.pool,
    revision: run.revision + (annex?.revision ?? 0),
    sequence: job.createdAt,
    ...(links.source === undefined ? {} : { source: links.source }),
    status,
    timestamps: {
      queuedAt: iso(job.createdAt),
      ...(settledAt === undefined ? {} : { settledAt: iso(settledAt) }),
      ...(run.startedAt === undefined ? {} : { startedAt: iso(run.startedAt) }),
      updatedAt,
    },
  };
}

const observationBase = {
  endedAt: z.string().optional(),
  errorCode: z.string().optional(),
  id: z.string(),
  startedAt: z.string(),
  status: z.enum(["running", "complete", "failed", "denied", "cancelled"]),
};

const observationSchema = z.union([
  z.looseObject({
    ...observationBase,
    kind: z.literal("model-turn"),
    model: z.string(),
    provider: z.string().optional(),
    sessionId: z.string(),
    usage: z.record(z.string(), z.unknown()).optional(),
  }),
  z.looseObject({
    ...observationBase,
    kind: z.literal("tool-call"),
    name: z.string(),
    sessionId: z.string(),
  }),
  z.looseObject({
    ...observationBase,
    data: z.unknown().optional(),
    kind: z.enum(["effect", "result"]),
    type: z.string(),
  }),
]);

export function annexOf(
  stored: StoredAnnex,
  dropped?: (count: number) => void
): ExecutionAnnex {
  const observations = stored.observations.flatMap((value) => {
    const parsed = observationSchema.safeParse(value);
    return parsed.success ? [parsed.data as ExecutionObservation] : [];
  });
  if (observations.length < stored.observations.length) {
    dropped?.(stored.observations.length - observations.length);
  }
  return {
    id: stored.id,
    observations,
    ...(stored.progress === undefined
      ? {}
      : { progress: stored.progress as JsonValue }),
    revision: stored.revision,
    ...(stored.updatedAt === undefined ? {} : { updatedAt: stored.updatedAt }),
  };
}

export function withObservation(
  observations: readonly ExecutionObservation[],
  observation: ExecutionObservation,
  keepStart: boolean
): ExecutionObservation[] {
  const at = observations.findIndex((item) => item.id === observation.id);
  if (at === -1) {
    return [...observations, observation];
  }
  const previous = observations[at];
  return [
    ...observations.slice(0, at),
    ...observations.slice(at + 1),
    keepStart && previous
      ? { ...observation, startedAt: previous.startedAt }
      : observation,
  ];
}

export function bySequence(a: ExecutionRun, b: ExecutionRun): number {
  return a.sequence - b.sequence || a.id.localeCompare(b.id);
}
