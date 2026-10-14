import type {
  ExecutionObservation,
  ExecutionRun,
  ExecutionUsage,
  ObservationStatus,
} from "@foundry.sh/marbles/engine";
import {
  type ExecutionStatus,
  SETTLED_EXECUTION_STATUSES,
} from "@foundry.sh/marbles/statuses";
import { WORKS_TASKS } from "./execution";
import {
  gatewayCall,
  type SaveActor,
  saveAttempt,
  savedEvidence,
  unrecordedGatewayCalls,
} from "./observations";

/**
 * Modules auditing (spec §9): what main sends about engine runs, how the
 * renderer reconciles it, and the read-only projections each Modules tab
 * shows. Runs are the engine's own records, minus the queued input and the
 * owning process; nothing here copies product records, which the renderer
 * joins by ID.
 */

export type AuditRunStatus = ExecutionStatus;
export type AuditObservationStatus = ObservationStatus;
type AuditObservation = ExecutionObservation;

/**
 * One engine run as the audit views read it: without its queued input or
 * owning process. Each run carries only some correlation keys.
 */
export type AuditRun = Omit<ExecutionRun, "correlation" | "input" | "owner"> & {
  readonly correlation: Readonly<Partial<Record<string, string>>>;
};

/** Runs retention removed from one scope (`host` or `module:<id>`). */
export interface AuditGap {
  readonly removed: number;
  readonly scope: string;
  readonly through: string;
  readonly updatedAt: string;
}

export type AuditEvent =
  /** Everything retained now; replaces whatever the reader held. */
  | {
      readonly gaps: readonly AuditGap[];
      readonly runs: readonly AuditRun[];
      readonly type: "snapshot";
    }
  /** A run changed: keep the highest revision per id. */
  | { readonly run: AuditRun; readonly type: "run" }
  /** Retention removed these runs; the gaps now cover them. */
  | {
      readonly gaps: readonly AuditGap[];
      readonly ids: readonly string[];
      readonly type: "removed";
    };

export interface AuditState {
  readonly gaps: readonly AuditGap[];
  readonly runs: ReadonlyMap<string, AuditRun>;
}

/**
 * Reconcile one event: a snapshot replaces the state (a reconnect never
 * duplicates), a run is kept only when newer than what is held, and a
 * removal drops runs and updates the gaps.
 */
export function applyAuditEvent(
  state: AuditState | null,
  event: AuditEvent
): AuditState {
  if (event.type === "snapshot") {
    return {
      gaps: event.gaps,
      runs: new Map(event.runs.map((run) => [run.id, run])),
    };
  }
  const current = state ?? { gaps: [], runs: new Map() };
  if (event.type === "removed") {
    const runs = new Map(current.runs);
    for (const id of event.ids) {
      runs.delete(id);
    }
    return { gaps: event.gaps, runs };
  }
  const held = current.runs.get(event.run.id);
  if (held && held.revision >= event.run.revision) {
    return current;
  }
  const runs = new Map(current.runs);
  runs.set(event.run.id, event.run);
  return { gaps: current.gaps, runs };
}

/** The Module a run belongs to, if any. */
export function runModule(run: AuditRun): string | undefined {
  return run.correlation.moduleId;
}

/** The scope a gap names as a Module id, or null for host actions. */
export function gapModule(gap: AuditGap): string | null {
  return gap.scope.startsWith("module:")
    ? gap.scope.slice("module:".length)
    : null;
}

export interface AuditFilter {
  /** Only this Module's runs; all when absent. */
  readonly moduleId?: string;
  /** Only runs queued at or after this time. */
  readonly since?: number;
}

/** Retained runs in scope, newest first. */
export function scopedRuns(
  state: AuditState,
  filter: AuditFilter = {}
): AuditRun[] {
  return [...state.runs.values()]
    .filter(
      (run) =>
        (filter.moduleId === undefined || runModule(run) === filter.moduleId) &&
        (filter.since === undefined ||
          Date.parse(run.timestamps.queuedAt) >= filter.since)
    )
    .sort((a, b) => b.sequence - a.sequence);
}

/** Gaps that touch the filter's scope. */
export function scopedGaps(
  state: AuditState,
  filter: AuditFilter = {}
): AuditGap[] {
  return state.gaps.filter(
    (gap) => filter.moduleId === undefined || gapModule(gap) === filter.moduleId
  );
}

const LABELS: Readonly<Record<string, string>> = {
  [WORKS_TASKS.authoringTurn]: "Chat turn",
  [WORKS_TASKS.access]: "Access change",
  [WORKS_TASKS.build]: "Build",
  [WORKS_TASKS.create]: "Module create",
  [WORKS_TASKS.fileCreate]: "File create",
  [WORKS_TASKS.fileRecover]: "File save recovery",
  [WORKS_TASKS.fileRevise]: "File working copy",
  [WORKS_TASKS.fileSave]: "File save",
  [WORKS_TASKS.fileSync]: "File disk sync",
  [WORKS_TASKS.import]: "Module import",
  [WORKS_TASKS.power]: "Module on/off",
  [WORKS_TASKS.program]: "App (Program lifetime)",
  [WORKS_TASKS.publish]: "Release publish",
  [WORKS_TASKS.save]: "Source save",
  [WORKS_TASKS.sourceRecover]: "Source save recovery",
  [WORKS_TASKS.sourceSync]: "Source disk sync",
  [WORKS_TASKS.select]: "Release select",
  [WORKS_TASKS.settings]: "Settings change",
};

/** A short, readable name for what a run does. */
export function runLabel(run: AuditRun): string {
  if (isWorkflowRun(run)) {
    return `Workflow ${run.name}`;
  }
  return LABELS[run.name] ?? run.name;
}

/** Registered workflows a Module started, and engine workflow definitions. */
export function isWorkflowRun(run: AuditRun): boolean {
  return run.kind === "workflow" || run.correlation.workflow !== undefined;
}

/** Runs whose purpose is to commit a save. */
const SAVE_TASKS: ReadonlySet<string> = new Set([
  WORKS_TASKS.fileCreate,
  WORKS_TASKS.fileSave,
  WORKS_TASKS.fileSync,
  WORKS_TASKS.publish,
  WORKS_TASKS.save,
  WORKS_TASKS.sourceSync,
]);

type SavedKind = "file" | "release" | "source";

/** One committed save, as Artifact Saves lists it. */
export interface ArtifactSaveRow {
  /** `created` for a new File Artifact's first Content. */
  readonly action: "created" | "saved";
  readonly artifactId: string;
  readonly contentId: string;
  readonly id: string;
  readonly kind: SavedKind;
  readonly moduleId?: string;
  /** Who the save is attributed to. */
  readonly origin: SaveActor;
  /** The entry written, for a file save of one entry. */
  readonly path?: string | null;
  /** The run whose own result write failed, for a recovered save. */
  readonly recoveredFrom?: string;
  readonly runId: string;
  readonly tag?: string;
  readonly updatedAt: string;
}

/** Every committed save a run reports. Failed attempts report none. */
function committedSaves(run: AuditRun): ArtifactSaveRow[] {
  return run.observations.flatMap((observation) => {
    const data = savedEvidence(observation);
    if (!data) {
      return [];
    }
    const moduleId = data.moduleId ?? runModule(run);
    return [
      {
        action:
          observation.kind === "result" && observation.type === "create"
            ? "created"
            : "saved",
        artifactId: data.artifactId,
        contentId: data.contentId,
        id: `${run.id}/${observation.id}`,
        kind: data.kind,
        ...(moduleId === undefined ? {} : { moduleId }),
        origin: data.actor,
        ...(data.kind === "file" ? { path: data.path } : {}),
        ...(data.recoveredFrom === undefined
          ? {}
          : { recoveredFrom: data.recoveredFrom }),
        runId: run.id,
        ...(data.kind !== "file" && data.tag !== undefined
          ? { tag: data.tag }
          : {}),
        updatedAt: data.updatedAt,
      },
    ];
  });
}

/** Committed saves, newest first. */
export function artifactSaves(runs: readonly AuditRun[]): ArtifactSaveRow[] {
  const rows = runs.flatMap(committedSaves);
  // A recovered save is the same save as the run whose result write failed.
  // That run, or an earlier recovery attempt, may still show it (it stays in
  // memory, or a later write of the run landed): it is listed once, as
  // recovered.
  const recovered = new Map<string, ArtifactSaveRow>();
  for (const row of rows) {
    if (row.recoveredFrom !== undefined) {
      recovered.set(row.recoveredFrom, row);
    }
  }
  return rows
    .filter((row) =>
      row.recoveredFrom === undefined
        ? !recovered.has(row.runId)
        : recovered.get(row.recoveredFrom) === row
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Why a settled save run committed nothing: the typed attempt outcome it
 * reported (conflict, stale, denied…), else its error code or status.
 * Null when it is not a save run, has not settled, or committed a save.
 */
export function failedSaveAttempt(run: AuditRun): string | null {
  if (
    !(SAVE_TASKS.has(run.name) && SETTLED_EXECUTION_STATUSES.has(run.status)) ||
    committedSaves(run).length > 0
  ) {
    return null;
  }
  for (const observation of run.observations) {
    const attempt = saveAttempt(observation);
    if (attempt) {
      return attempt.outcome;
    }
  }
  if (run.error) {
    return run.error.code;
  }
  // A disk sync that found nothing to write ends complete with no save.
  return run.status === "complete" ? "no-change" : run.status;
}

type CallKind = "gateway" | "model-turn" | "tool-call";

/** One engine-observed call. */
export interface CallRow {
  readonly durationMs?: number;
  readonly endedAt?: string;
  readonly errorCode?: string;
  readonly id: string;
  readonly kind: CallKind;
  readonly moduleId?: string;
  /** Model, tool, or Capability. */
  readonly name: string;
  readonly provider?: string;
  readonly runId: string;
  readonly sessionId?: string;
  readonly startedAt: string;
  readonly status: AuditObservationStatus;
  readonly usage?: ExecutionUsage;
}

function callOf(run: AuditRun, observation: AuditObservation): CallRow | null {
  const base = {
    ...(observation.endedAt === undefined
      ? {}
      : {
          durationMs:
            Date.parse(observation.endedAt) - Date.parse(observation.startedAt),
          endedAt: observation.endedAt,
        }),
    ...(observation.errorCode === undefined
      ? {}
      : { errorCode: observation.errorCode }),
    id: `${run.id}/${observation.id}`,
    ...(runModule(run) === undefined ? {} : { moduleId: runModule(run) }),
    runId: run.id,
    startedAt: observation.startedAt,
    status: observation.status,
  };
  if (observation.kind === "model-turn") {
    return {
      ...base,
      kind: "model-turn",
      name: observation.model,
      ...(observation.provider === undefined
        ? {}
        : { provider: observation.provider }),
      sessionId: observation.sessionId,
      ...(observation.usage === undefined ? {} : { usage: observation.usage }),
    };
  }
  if (observation.kind === "tool-call") {
    return {
      ...base,
      kind: "tool-call",
      name: observation.name,
      sessionId: observation.sessionId,
    };
  }
  const call = gatewayCall(observation);
  if (call) {
    return {
      ...base,
      kind: "gateway",
      name:
        call.capability === undefined
          ? "Undeclared Capability"
          : `${call.capability}@${String(call.version ?? "?")}`,
    };
  }
  return null;
}

/** Model turns, tool calls and Gateway invocations, newest first. */
export function callRows(runs: readonly AuditRun[]): CallRow[] {
  return runs
    .flatMap((run) =>
      run.observations.flatMap((observation) => {
        const call = callOf(run, observation);
        return call ? [call] : [];
      })
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Gateway invocations long-lived Programs counted but did not list. */
function uncountedCalls(runs: readonly AuditRun[]): number {
  let count = 0;
  for (const run of runs) {
    for (const observation of run.observations) {
      count += unrecordedGatewayCalls(observation);
    }
  }
  return count;
}

const USAGE_FIELDS = ["inputTokens", "outputTokens", "totalTokens"] as const;
type UsageField = (typeof USAGE_FIELDS)[number];

/** A token total over model turns: known sum, and how many turns left it unknown. */
export interface UsageTotal {
  readonly known: number;
  readonly unknownTurns: number;
}

export interface AuditDashboard {
  readonly byKind: readonly {
    readonly count: number;
    readonly label: string;
  }[];
  /** Run counts by status; statuses with no runs are left out. */
  readonly byStatus: readonly {
    readonly count: number;
    readonly status: AuditRunStatus;
  }[];
  readonly calls: Readonly<Record<CallKind, number>>;
  /** Cost is never reported by providers here, so it is always unknown. */
  readonly cost: "unknown";
  /** Model turns that reported usage at all, out of all model turns. */
  readonly coverage: { readonly measured: number; readonly turns: number };
  readonly runs: number;
  readonly unrecordedGatewayCalls: number;
  readonly usage: Readonly<Record<UsageField, UsageTotal>>;
}

/** Counts and usage of the runs in scope. */
export function auditDashboard(runs: readonly AuditRun[]): AuditDashboard {
  const byKind = new Map<string, number>();
  const byStatus = new Map<AuditRunStatus, number>();
  for (const run of runs) {
    const label = runLabel(run);
    byKind.set(label, (byKind.get(label) ?? 0) + 1);
    byStatus.set(run.status, (byStatus.get(run.status) ?? 0) + 1);
  }
  const calls = callRows(runs);
  const turns = calls.filter((call) => call.kind === "model-turn");
  const usage = Object.fromEntries(
    USAGE_FIELDS.map((field) => {
      let known = 0;
      let unknownTurns = 0;
      for (const turn of turns) {
        const value = turn.usage?.[field];
        if (value === undefined) {
          unknownTurns += 1;
        } else {
          known += value;
        }
      }
      return [field, { known, unknownTurns }];
    })
  ) as Record<UsageField, UsageTotal>;
  return {
    byKind: [...byKind]
      .map(([label, count]) => ({ count, label }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    byStatus: [...byStatus].map(([status, count]) => ({ count, status })),
    calls: {
      gateway: calls.filter((call) => call.kind === "gateway").length,
      "model-turn": turns.length,
      "tool-call": calls.filter((call) => call.kind === "tool-call").length,
    },
    cost: "unknown",
    coverage: {
      measured: turns.filter((turn) => turn.usage !== undefined).length,
      turns: turns.length,
    },
    runs: runs.length,
    unrecordedGatewayCalls: uncountedCalls(runs),
    usage,
  };
}
