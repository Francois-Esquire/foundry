import type { CollectionProgressEvent, ScanProgressEvent } from "../lib/scan";
import type { SemanticsHistoryProgressEvent } from "../lib/semantics-history";

// The CLI's model of a scan in flight. It folds the library's progress
// events into one snapshot a display reads: which phase, which packages
// are being analyzed, how many of how many, what was reused. It knows
// nothing of terminals; `spyglass.ts` prints its lines when piped, and
// `loader.ts` draws its snapshot in a terminal.

/** A phase the scan entered, closed with its duration when the next began. */
export interface PhaseRecord {
  readonly detail?: string;
  readonly durationMs?: number;
  readonly name: string;
  readonly startedAt: number;
}

type UnitStatus = "complete" | "failed" | "reused" | "started";

/** A package under analysis now, and when its worker began. */
interface ActiveUnit {
  readonly startedAt: number;
  readonly unit: string;
}

/** The last thing that happened to one package's analysis. */
export interface UnitRecord {
  readonly durationMs: number;
  readonly error?: string;
  readonly status: UnitStatus;
  readonly unit: string;
}

/** Package analysis: counts from `unit` events, pending names from the plan. */
export interface UnitsProgress {
  /** Packages whose analysis has started and not ended, in starting order. */
  readonly active: readonly ActiveUnit[];
  readonly analyzed: number;
  readonly done: number;
  readonly failed: number;
  /** The most recently finished packages, newest first; at most `RECENT`. */
  readonly recent: readonly UnitRecord[];
  readonly reused: number;
  readonly total: number;
}

/** Git history: its phases and its checkpoints as they complete. */
interface HistoryProgress {
  readonly checkpoints: {
    readonly cached: number;
    readonly done: number;
    readonly failed: number;
    readonly total: number;
  };
  readonly phases: readonly PhaseRecord[];
}

export interface ProgressSnapshot {
  readonly history?: HistoryProgress;
  /** Which package's internals are being derived, and its position. */
  readonly internals?: { index: number; package: string; total: number };
  readonly phases: readonly PhaseRecord[];
  /** From the invalidation plan: how many local analyses are reused and recomputed. */
  readonly plan?: { recompute: number; reuse: number };
  readonly startedAt: number;
  readonly units: UnitsProgress;
  /** For a collection, the root whose scan is running. */
  readonly workspace?: string;
  /** How many workspaces have started; one for a single workspace. */
  readonly workspaces: number;
}

const RECENT = 5;

const EMPTY_UNITS: UnitsProgress = {
  active: [],
  analyzed: 0,
  done: 0,
  failed: 0,
  recent: [],
  reused: 0,
  total: 0,
};

/** Adds or extends a phase: a repeated name (derive reports its timing twice) updates the detail. */
function enterPhase(
  phases: readonly PhaseRecord[],
  name: string,
  detail: string | undefined,
  now: number
): PhaseRecord[] {
  const last = phases.at(-1);
  if (
    last !== undefined &&
    last.name === name &&
    last.durationMs === undefined
  ) {
    return [
      ...phases.slice(0, -1),
      { ...last, ...(detail !== undefined && { detail }) },
    ];
  }
  const closed =
    last === undefined || last.durationMs !== undefined
      ? phases
      : [
          ...phases.slice(0, -1),
          {
            ...last,
            durationMs: Math.max(0, Math.round(now - last.startedAt)),
          },
        ];
  return [
    ...closed,
    { ...(detail !== undefined && { detail }), name, startedAt: now },
  ];
}

function foldUnit(
  units: UnitsProgress,
  event: Extract<ScanProgressEvent, { kind: "unit" }>,
  now: number
): UnitsProgress {
  const active = units.active.filter(({ unit }) => unit !== event.unit);
  if (event.status === "started") {
    return {
      ...units,
      active: [...active, { startedAt: now, unit: event.unit }],
      total: event.total,
    };
  }
  const record: UnitRecord = {
    durationMs: event.durationMs,
    ...(event.error !== undefined && { error: event.error }),
    status: event.status,
    unit: event.unit,
  };
  return {
    active,
    analyzed: units.analyzed + (event.status === "complete" ? 1 : 0),
    done: event.done,
    failed: units.failed + (event.status === "failed" ? 1 : 0),
    recent: [record, ...units.recent].slice(0, RECENT),
    reused: units.reused + (event.status === "reused" ? 1 : 0),
    total: event.total,
  };
}

function foldHistory(
  history: HistoryProgress | undefined,
  event: SemanticsHistoryProgressEvent,
  now: number
): HistoryProgress {
  const current = history ?? {
    checkpoints: { cached: 0, done: 0, failed: 0, total: 0 },
    phases: [],
  };
  if (event.kind === "phase") {
    return {
      ...current,
      phases: enterPhase(current.phases, event.phase, event.detail, now),
    };
  }
  if (event.kind === "checkpoint") {
    const { checkpoints } = current;
    return {
      ...current,
      checkpoints: {
        cached: checkpoints.cached + (event.status === "cached" ? 1 : 0),
        done: event.done,
        failed: checkpoints.failed + (event.status === "failed" ? 1 : 0),
        total: event.total,
      },
    };
  }
  return current;
}

/** The lines the piped CLI has always printed for one event; empty for the rest. */
function plainLines(event: ScanProgressEvent): string[] {
  if (event.kind === "phase") {
    return [`${event.phase}${event.detail ? `: ${event.detail}` : ""}`];
  }
  if (event.kind === "internals") {
    return [`internals: ${event.package}`];
  }
  return [];
}

/**
 * Folds progress events, from one workspace's scan or a collection's, into
 * a snapshot. `fold` returns the plain lines that event adds, so a piped
 * run prints exactly what it did before this model existed.
 */
export class ScanProgress {
  private current: ProgressSnapshot;
  private readonly now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
    this.current = {
      phases: [],
      startedAt: now(),
      units: EMPTY_UNITS,
      workspaces: 0,
    };
  }

  get snapshot(): ProgressSnapshot {
    return this.current;
  }

  fold(event: CollectionProgressEvent | ScanProgressEvent): string[] {
    if (event.kind === "workspace") {
      const lines: string[] = [];
      if (event.root !== this.current.workspace) {
        // Each workspace's scan starts its phases afresh; the counts accumulate.
        this.current = {
          ...this.current,
          internals: undefined,
          phases: [],
          plan: undefined,
          units: { ...this.current.units, active: [], done: 0, total: 0 },
          workspace: event.root,
          workspaces: this.current.workspaces + 1,
        };
        lines.push(`workspace: ${event.root}`);
      }
      lines.push(...this.foldScan(event.event));
      return lines;
    }
    if (this.current.workspaces === 0) {
      this.current = { ...this.current, workspaces: 1 };
    }
    return this.foldScan(event);
  }

  private foldScan(event: ScanProgressEvent): string[] {
    const now = this.now();
    switch (event.kind) {
      case "phase":
        this.current = {
          ...this.current,
          internals: undefined,
          phases: enterPhase(
            this.current.phases,
            event.phase,
            event.detail,
            now
          ),
        };
        break;
      case "plan": {
        const locals = event.invalidations.filter(
          (invalidation) => invalidation.kind === "package-local"
        );
        this.current = {
          ...this.current,
          plan: {
            recompute: locals.filter((i) => i.status === "recompute").length,
            reuse: locals.filter((i) => i.status === "reuse").length,
          },
        };
        break;
      }
      case "unit":
        this.current = {
          ...this.current,
          units: foldUnit(this.current.units, event, now),
        };
        break;
      case "internals":
        this.current = {
          ...this.current,
          internals: {
            index: event.index,
            package: event.package,
            total: event.total,
          },
        };
        break;
      case "history":
        this.current = {
          ...this.current,
          history: foldHistory(this.current.history, event.event, now),
        };
        break;
      default:
        break;
    }
    return plainLines(event);
  }
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** `0.4s`, `12s`, `2m 05s`: the precision a person reads at that scale. */
export function formatDuration(ms: number): string {
  if (ms < 10 * SECOND) {
    return `${(ms / SECOND).toFixed(1)}s`;
  }
  if (ms < MINUTE) {
    return `${Math.round(ms / SECOND)}s`;
  }
  const minutes = Math.floor(ms / MINUTE);
  const seconds = Math.round((ms - minutes * MINUTE) / SECOND);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * One line for the scrollback once the live display is gone:
 * `Scanned 16 packages in 41s: 3 analyzed, 13 reused.`
 */
export function summaryLine(snapshot: ProgressSnapshot, now: number): string {
  const { units, workspaces } = snapshot;
  const counts = [
    `${units.analyzed} analyzed`,
    `${units.reused} reused`,
    ...(units.failed > 0 ? [`${units.failed} failed`] : []),
  ].join(", ");
  const scope =
    workspaces > 1
      ? `${plural(workspaces, "workspace")}, ${plural(units.analyzed + units.reused + units.failed, "package")}`
      : plural(units.total, "package");
  return `Scanned ${scope} in ${formatDuration(now - snapshot.startedAt)}: ${counts}.`;
}
