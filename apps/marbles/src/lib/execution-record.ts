import type { JsonValue } from "@foundry/lib/json";
import { EXECUTION_STATUSES, type ExecutionStatus } from "./execution-statuses";
import { isRecord } from "./state/json";
/** The default queue for a launch that names none. */
export const DEFAULT_QUEUE = "marbles";
const STATUSES: ReadonlySet<string> = new Set(EXECUTION_STATUSES);
const OBSERVATION_STATUSES: ReadonlySet<string> = new Set<ObservationStatus>([
  "running",
  "complete",
  "failed",
  "denied",
  "cancelled",
]);

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

/**
 * What a host reads and steers: the retained runs, their lifecycle as it
 * happens, and the queues. Changes made by another process sharing the store
 * are not announced as they happen; subscribing reads the store again, so a
 * fresh subscription's snapshot carries what other processes wrote or
 * pruned since.
 */
export interface ExecutionRuns {
  /** Set a queue's concurrency, now; it is created if it does not exist. */
  configure(queue: string, settings: QueueSettings): void;
  /** What pruning has removed, by scope. */
  gaps(): readonly RetentionGap[];
  get(id: string): ExecutionRun | undefined;
  /** Every retained run, in admission order. */
  list(): readonly ExecutionRun[];
  /**
   * Remove settled runs for good, recording each one's scope in its gap
   * first. Ids of unknown or unsettled runs are skipped. Returns the runs
   * removed; subscribers are not told (the caller knows). Throws without
   * removing anything if another process holds the retention lock; retry later.
   */
  prune(
    ids: Iterable<string>,
    scopeOf: (run: ExecutionRun) => string
  ): readonly ExecutionRun[];
  queues(): readonly QueueState[];
  /**
   * Every change from now on, each as the whole new record. The snapshot is
   * taken in the same tick, so snapshot and updates together miss nothing;
   * reconcile by `id`, keeping the highest `revision`. The snapshot is read
   * from the store, so after a disconnect, or to see what another process
   * sharing the store did, subscribe again.
   */
  subscribe(listener: (run: ExecutionRun) => void): ExecutionSubscription;
}

export interface EnqueueInput {
  readonly correlation?: Readonly<Record<string, string>>;
  readonly input?: unknown;
  readonly kind: ExecutionRun["kind"];
  readonly name: string;
  readonly queue: string;
  readonly source?: string;
}

/** What one observation appends to its run's log. */
export interface LoggedObservation {
  readonly observation: ExecutionObservation;
  readonly revision: number;
  readonly updatedAt: string;
}

export function now(): string {
  return new Date().toISOString();
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

/** A stored observation with every field its kind needs. */
function isObservation(value: unknown): value is ExecutionObservation {
  if (
    !(
      isRecord(value) &&
      typeof value.id === "string" &&
      typeof value.startedAt === "string" &&
      typeof value.status === "string" &&
      OBSERVATION_STATUSES.has(value.status) &&
      optionalString(value.endedAt) &&
      optionalString(value.errorCode)
    )
  ) {
    return false;
  }
  switch (value.kind) {
    case "model-turn":
      return (
        typeof value.model === "string" &&
        typeof value.sessionId === "string" &&
        optionalString(value.provider) &&
        (value.usage === undefined || isRecord(value.usage))
      );
    case "tool-call":
      return (
        typeof value.name === "string" && typeof value.sessionId === "string"
      );
    case "effect":
    case "result":
      return typeof value.type === "string";
    default:
      return false;
  }
}

/**
 * A stored record, when it has every field a run needs. An unsettled run's
 * record leaves its observations to its log, unless its store keeps none.
 * An observation that is not one is left out, and counted in `dropped`.
 */
export function parseRun(
  value: unknown,
  dropped?: (count: number) => void
): ExecutionRun | undefined {
  if (
    !(isRecord(value) && isRecord(value.owner) && isRecord(value.timestamps))
  ) {
    return undefined;
  }
  const valid =
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.queue === "string" &&
    typeof value.status === "string" &&
    STATUSES.has(value.status) &&
    (value.kind === "workflow" || value.kind === "task") &&
    typeof value.revision === "number" &&
    typeof value.sequence === "number" &&
    typeof value.owner.pid === "number" &&
    typeof value.timestamps.queuedAt === "string" &&
    isRecord(value.correlation) &&
    (value.observations === undefined || Array.isArray(value.observations));
  if (!valid) {
    return undefined;
  }
  const stored: readonly unknown[] = Array.isArray(value.observations)
    ? value.observations
    : [];
  const observations = stored.filter(isObservation);
  if (observations.length < stored.length) {
    dropped?.(stored.length - observations.length);
  }
  return { ...value, observations } as unknown as ExecutionRun;
}

export function isLogged(value: unknown): value is LoggedObservation {
  return (
    isRecord(value) &&
    isObservation(value.observation) &&
    typeof value.revision === "number" &&
    typeof value.updatedAt === "string"
  );
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

export function parseGaps(value: unknown): Map<string, RetentionGap> {
  const gaps = new Map<string, RetentionGap>();
  const stored = isRecord(value) && isRecord(value.gaps) ? value.gaps : {};
  for (const [scope, gap] of Object.entries(stored)) {
    if (
      isRecord(gap) &&
      typeof gap.removed === "number" &&
      typeof gap.through === "string" &&
      typeof gap.updatedAt === "string"
    ) {
      gaps.set(scope, {
        removed: gap.removed,
        scope,
        through: gap.through,
        updatedAt: gap.updatedAt,
      });
    }
  }
  return gaps;
}

export function bySequence(a: ExecutionRun, b: ExecutionRun): number {
  return a.sequence - b.sequence || a.id.localeCompare(b.id);
}

/** The next revision of a run with `patch` applied. */
export function nextRevision(
  run: ExecutionRun,
  patch: Partial<Omit<ExecutionRun, "id" | "revision">>
): ExecutionRun {
  return {
    ...run,
    ...patch,
    revision: run.revision + 1,
    timestamps: { ...run.timestamps, ...patch.timestamps, updatedAt: now() },
  };
}
