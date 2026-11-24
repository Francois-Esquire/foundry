import type { JsonValue } from "@foundry/lib/json";
import type { ProcessIdentity } from "@foundry/lib/process-identity";
import { z } from "zod";
import { EXECUTION_STATUSES, type ExecutionStatus } from "./execution-statuses";
import type { StoredExecution } from "./execution-store";
export const DEFAULT_QUEUE = "marbles";

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
  readonly kind: "workflow" | "task";
  readonly name: string;
  readonly observations: readonly ExecutionObservation[];
  readonly owner: ProcessIdentity;
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

export interface EnqueueInput {
  readonly correlation?: Readonly<Record<string, string>>;
  readonly input?: unknown;
  readonly kind: ExecutionRun["kind"];
  readonly name: string;
  readonly queue: string;
  readonly source?: string;
}

export function now(): string {
  return new Date().toISOString();
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

const recordSchema = z.looseObject({
  correlation: z.record(z.string(), z.string()),
  error: z
    .object({ code: z.string(), message: z.string().optional() })
    .optional(),
  id: z.string(),
  input: z.unknown().optional(),
  kind: z.enum(["workflow", "task"]),
  name: z.string(),
  owner: z.object({
    pid: z.number(),
    started: z.string().nullable().default(null),
  }),
  progress: z.unknown().optional(),
  queue: z.string(),
  revision: z.number(),
  sequence: z.number(),
  source: z.string().optional(),
  status: z.enum(EXECUTION_STATUSES),
  timestamps: z.object({
    queuedAt: z.string(),
    settledAt: z.string().optional(),
    startedAt: z.string().optional(),
    updatedAt: z.string(),
  }),
});

export function parseStored(
  stored: StoredExecution,
  dropped?: (count: number) => void
): ExecutionRun | undefined {
  const record = recordSchema.safeParse(stored.value);
  if (!record.success || record.data.id !== stored.id) {
    return undefined;
  }
  const observations = stored.observations.flatMap((value) => {
    const parsed = observationSchema.safeParse(value);
    return parsed.success ? [parsed.data as ExecutionObservation] : [];
  });
  if (observations.length < stored.observations.length) {
    dropped?.(stored.observations.length - observations.length);
  }
  return { ...record.data, observations } as unknown as ExecutionRun;
}

export function withObservation(
  observations: readonly ExecutionObservation[],
  index: Map<string, number>,
  observation: ExecutionObservation,
  keepStart: boolean
): ExecutionObservation[] {
  const at = index.get(observation.id);
  if (at === undefined) {
    index.set(observation.id, observations.length);
    return [...observations, observation];
  }
  const previous = observations[at];
  const next = [
    ...observations.slice(0, at),
    ...observations.slice(at + 1),
    keepStart && previous
      ? { ...observation, startedAt: previous.startedAt }
      : observation,
  ];
  index.clear();
  for (const [position, item] of next.entries()) {
    index.set(item.id, position);
  }
  return next;
}

export function indexOf(
  observations: readonly ExecutionObservation[]
): Map<string, number> {
  return new Map(observations.map((item, position) => [item.id, position]));
}

export function jsonInput(value: unknown, path = "input"): JsonValue {
  checkJson(value, path, new Set());
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function checkJson(item: unknown, at: string, seen: Set<object>): void {
  if (item === null || typeof item === "string" || typeof item === "boolean") {
    return;
  }
  if (typeof item === "number") {
    if (!Number.isFinite(item)) {
      throw new TypeError(`${at} is not JSON: ${String(item)} is not finite`);
    }
    return;
  }
  if (typeof item !== "object") {
    throw new TypeError(`${at} is not JSON: it is a ${typeof item}`);
  }
  if (seen.has(item)) {
    throw new TypeError(`${at} is not JSON: it refers to itself`);
  }
  seen.add(item);
  if (Array.isArray(item)) {
    checkJsonArray(item, at, seen);
  } else {
    checkJsonObject(item, at, seen);
  }
  seen.delete(item);
}

function checkJsonArray(
  items: readonly unknown[],
  at: string,
  seen: Set<object>
): void {
  for (const [position, element] of items.entries()) {
    if (element === undefined) {
      throw new TypeError(`${at}[${position}] is not JSON: it is undefined`);
    }
    checkJson(element, `${at}[${position}]`, seen);
  }
}

function checkJsonObject(item: object, at: string, seen: Set<object>): void {
  const prototype = Object.getPrototypeOf(item) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    const name =
      (item as { constructor?: { name?: string } }).constructor?.name ??
      "object";
    throw new TypeError(
      `${at} is not JSON: it is a ${name}, not a plain object`
    );
  }
  for (const [key, entry] of Object.entries(item)) {
    if (entry !== undefined) {
      checkJson(entry, `${at}.${key}`, seen);
    }
  }
}

export function bySequence(a: ExecutionRun, b: ExecutionRun): number {
  return a.sequence - b.sequence || a.id.localeCompare(b.id);
}
