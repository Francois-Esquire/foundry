import type { JsonValue } from "@foundry/lib/json";
import { z } from "zod";
import { EXECUTION_STATUSES, type ExecutionStatus } from "./execution-statuses";
import type { StoredExecution } from "./execution-store";
/** The default queue for a launch that names none. */
export const DEFAULT_QUEUE = "marbles";

/**
 * Token counts a provider reported for a model turn. A count is present only
 * when every model call in the turn reported it; otherwise it is unknown and
 * absent, never zero.
 */
export interface ExecutionUsage {
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  /** Who measured it: the provider's own response. */
  readonly source: "provider";
  readonly totalTokens?: number;
}

export type ObservationStatus =
  | "running"
  | "complete"
  | "failed"
  /** A tool call the agent's authority refused. */
  | "denied"
  | "cancelled";

interface ObservationBase {
  readonly endedAt?: string;
  /** A short, safe classification of a failure, such as an error's name; never its message. */
  readonly errorCode?: string;
  /** Unique within its run; recording the same id again replaces it. */
  readonly id: string;
  readonly startedAt: string;
  readonly status: ObservationStatus;
}

/** One `stream` or `generate` call on an agent session; it may span several model requests. */
export interface ModelTurnObservation extends ObservationBase {
  readonly kind: "model-turn";
  readonly model: string;
  readonly provider?: string;
  readonly sessionId: string;
  readonly usage?: ExecutionUsage;
}

/** A tool an agent called: its name and outcome, never its arguments or result. */
export interface ToolCallObservation extends ObservationBase {
  readonly kind: "tool-call";
  readonly name: string;
  readonly sessionId: string;
}

/** What a host task did (`effect`) or produced (`result`), in the host's own `type` and data. */
export interface HostObservation extends ObservationBase {
  readonly data?: JsonValue;
  readonly kind: "effect" | "result";
  readonly type: string;
}

export type ExecutionObservation =
  | ModelTurnObservation
  | ToolCallObservation
  | HostObservation;

/** A run's durable record. A new object, with a higher `revision`, at each change. */
export interface ExecutionRun {
  /** Host identifiers the run belongs to, such as `moduleId` or `agentSessionId`. */
  readonly correlation: Readonly<Record<string, string>>;
  /** Why it failed or was interrupted. */
  readonly error?: { readonly code: string; readonly message?: string };
  /** `rn-*`; a workflow run has the same id in the Orchestrator and the feed. */
  readonly id: string;
  /** Kept only while queued, to admit the run again after a restart. */
  readonly input?: JsonValue;
  /** A workflow definition run through the Orchestrator, or a host task. */
  readonly kind: "workflow" | "task";
  /** The definition or task name it was launched by. */
  readonly name: string;
  readonly observations: readonly ExecutionObservation[];
  /** The process that owns it while it is unsettled. */
  readonly owner: { readonly pid: number };
  /** The latest progress it reported. */
  readonly progress?: JsonValue;
  readonly queue: string;
  /** Increases with every change; a subscriber keeps the highest it has seen. */
  readonly revision: number;
  /** Admission order: increasing across launches, and kept across restarts. */
  readonly sequence: number;
  /** The caller's identity for the request; launching its name with it again returns this run. */
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
  /** Runs admitted at once: a positive integer, or `Infinity`. */
  readonly concurrency: number;
}

export interface QueueState extends QueueSettings {
  /** Runs holding a slot now. */
  readonly active: number;
  readonly name: string;
  /** Runs waiting their turn. */
  readonly waiting: number;
}

/**
 * What pruning removed from one host scope, such as a Module: a count and
 * the latest settlement among the removed runs. Runs of the scope that
 * settled up to `through` may be missing; later ones are all retained.
 */
export interface RetentionGap {
  /** Runs removed from this scope so far. */
  readonly removed: number;
  readonly scope: string;
  /** The latest `settledAt` of a removed run. */
  readonly through: string;
  /** When pruning last removed a run of this scope. */
  readonly updatedAt: string;
}

/** Retained runs at the moment of subscribing, and how to stop listening. */
export interface ExecutionSubscription {
  readonly snapshot: readonly ExecutionRun[];
  unsubscribe(): void;
}

export interface ExecutionRuns {
  /** Set a queue's concurrency, now; it is created if it does not exist. */
  configure(queue: string, settings: QueueSettings): void;
  /** What pruning has removed, by scope. */
  gaps(): readonly RetentionGap[];
  get(id: string): ExecutionRun | undefined;
  /** Every retained run, in admission order. */
  list(): readonly ExecutionRun[];
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
  owner: z.object({ pid: z.number() }),
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

/**
 * `observations` with `observation` recorded: replacing one by id moves it
 * last, and keeps the start it was first recorded with when `keepStart`
 * says its own was not given. `index` maps each id in `observations` to its
 * position, so a new id is found without a scan; it is rebuilt only when
 * one is replaced.
 */
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

/** Each observation's position by id. */
export function indexOf(
  observations: readonly ExecutionObservation[]
): Map<string, number> {
  return new Map(observations.map((item, position) => [item.id, position]));
}

/**
 * A run's input as its record keeps it: plain JSON. A launch's input is
 * written on its queued record so an exited process's queued run can be let
 * in again, and the run gets this same copy whether it starts now or after a
 * restart, so a caller that changes its object later changes nothing.
 * Anything JSON would drop or alter is refused rather than lost: a function,
 * symbol, bigint, `undefined` in an array, a number that is not finite, a
 * cycle, and any object that is not a plain object or an array (a `Date`, a
 * `Map`, a class instance).
 */
export function jsonInput(value: unknown, path = "input"): JsonValue {
  checkJson(value, path, new Set());
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** Throw unless `item`, found at `at`, is plain JSON (see {@link jsonInput}). */
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
    // A property left undefined is no property, as JSON has it.
    if (entry !== undefined) {
      checkJson(entry, `${at}.${key}`, seen);
    }
  }
}

export function bySequence(a: ExecutionRun, b: ExecutionRun): number {
  return a.sequence - b.sequence || a.id.localeCompare(b.id);
}
