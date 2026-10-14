import { MODULE_SETTING_HOST_POLICY } from "@foundry/modules/settings";
import type {
  ExecutionRun,
  ExecutionRuns,
  RetentionGap,
} from "@foundry.sh/marbles/engine";
import { SETTLED_EXECUTION_STATUSES } from "@foundry.sh/marbles/statuses";
import { savedEvidence } from "~/shared/observations";

/**
 * Run-store retention (spec §9, §10 `audit.*`): each Module's settled runs
 * are kept for its `audit.retentionDays` and up to its
 * `audit.maxTerminalEntries`; runs that belong to no Module (host actions
 * such as create, import and the user's own file saves) use the host
 * defaults. Only settled runs are pruned, and never the latest committed
 * save of an Artifact: that run is the save checkpoint and carries the
 * scoped operation identity a retried request and startup recovery read.
 * What was pruned stays visible as a gap per scope.
 */

/** The scope of runs that belong to no Module. */
export const HOST_AUDIT_SCOPE = "host";

export interface RetentionPolicy {
  readonly maxTerminalEntries: number;
  readonly retentionDays: number;
}

/** The host defaults, which are also the ceilings (spec §10). */
export const DEFAULT_RETENTION: RetentionPolicy = {
  maxTerminalEntries:
    MODULE_SETTING_HOST_POLICY["audit.maxTerminalEntries"].default,
  retentionDays: MODULE_SETTING_HOST_POLICY["audit.retentionDays"].default,
};

/** How often retention runs while Works is open. */
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The retention scope of a run, from its correlation. */
export function auditScope(
  correlation: Readonly<Record<string, string | undefined>>
): string {
  const { moduleId } = correlation;
  return moduleId === undefined ? HOST_AUDIT_SCOPE : `module:${moduleId}`;
}

/**
 * The committed saves a run reports, each as the Artifact checkpoint it
 * would be: `<artifactId>:<kind>` (file, source or release).
 */
function checkpoints(run: ExecutionRun): string[] {
  return run.observations.flatMap((observation) => {
    const evidence = savedEvidence(observation);
    return evidence ? [`${evidence.artifactId}:${evidence.kind}`] : [];
  });
}

/** Each Artifact's latest committed save run: never pruned. */
function protectedRuns(runs: readonly ExecutionRun[]): Set<string> {
  const latest = new Map<string, ExecutionRun>();
  for (const run of runs) {
    for (const checkpoint of checkpoints(run)) {
      const current = latest.get(checkpoint);
      if (!current || current.sequence < run.sequence) {
        latest.set(checkpoint, run);
      }
    }
  }
  return new Set([...latest.values()].map((run) => run.id));
}

/**
 * The settled runs to prune now, by scope: older than the scope's
 * retention, then the oldest beyond its entry limit. Protected runs count
 * toward the limit but are never chosen.
 */
function retentionCandidates(
  runs: readonly ExecutionRun[],
  policyOf: (scope: string) => RetentionPolicy,
  now: Date
): Map<string, string[]> {
  const keep = protectedRuns(runs);
  const settled = new Map<string, ExecutionRun[]>();
  for (const run of runs) {
    if (SETTLED_EXECUTION_STATUSES.has(run.status)) {
      const scope = auditScope(run.correlation);
      const scoped = settled.get(scope) ?? [];
      scoped.push(run);
      settled.set(scope, scoped);
    }
  }
  const chosen = new Map<string, string[]>();
  for (const [scope, scoped] of settled) {
    const policy = policyOf(scope);
    const cutoff = now.getTime() - policy.retentionDays * DAY_MS;
    const oldest = scoped.sort((a, b) => a.sequence - b.sequence);
    let remaining = oldest.length;
    const ids: string[] = [];
    for (const run of oldest) {
      if (keep.has(run.id)) {
        continue;
      }
      const settledAt = Date.parse(
        run.timestamps.settledAt ?? run.timestamps.updatedAt
      );
      if (settledAt < cutoff || remaining > policy.maxTerminalEntries) {
        ids.push(run.id);
        remaining -= 1;
      }
    }
    if (ids.length > 0) {
      chosen.set(scope, ids);
    }
  }
  return chosen;
}

export interface RetentionOptions {
  readonly now?: () => Date;
  /** A Module's effective `audit.*` settings; host defaults when it fails. */
  readonly policy?: (moduleId: string) => Promise<RetentionPolicy>;
  readonly runs: Pick<ExecutionRuns, "gaps" | "list" | "prune">;
}

/** What one compaction removed, and every scope's gap after it. */
export interface Compaction {
  readonly gaps: readonly RetentionGap[];
  readonly removed: readonly string[];
}

/**
 * Compacts the engine run store: at startup, then every
 * {@link RETENTION_INTERVAL_MS} while Works is open. Listeners hear what
 * each compaction removed, so live views drop it and show the gap.
 */
export class ExecutionRetention {
  readonly #listeners = new Set<(compaction: Compaction) => void>();
  readonly #now: () => Date;
  readonly #policy: RetentionOptions["policy"];
  readonly #runs: RetentionOptions["runs"];
  #compacting: Promise<Compaction> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: RetentionOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#policy = options.policy;
    this.#runs = options.runs;
  }

  /** Hear each compaction that removed something. */
  subscribe(listener: (compaction: Compaction) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Prune what retention allows now; one compaction at a time. */
  compact(): Promise<Compaction> {
    const previous = this.#compacting ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.#compact());
    this.#compacting = next;
    return next;
  }

  /** Compact now and then on an interval; the timer never keeps Works open. */
  start(intervalMs = RETENTION_INTERVAL_MS): Promise<Compaction> {
    this.#timer ??= setInterval(() => {
      this.compact().catch(() => undefined);
    }, intervalMs);
    this.#timer.unref?.();
    return this.compact();
  }

  async shutdown(): Promise<void> {
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#compacting?.catch(() => undefined);
  }

  async #compact(): Promise<Compaction> {
    const runs = this.#runs.list();
    const policies = new Map<string, RetentionPolicy>();
    for (const run of runs) {
      const { moduleId } = run.correlation;
      const scope = auditScope(run.correlation);
      if (!policies.has(scope)) {
        policies.set(
          scope,
          moduleId !== undefined && this.#policy
            ? await this.#policy(moduleId).catch(() => DEFAULT_RETENTION)
            : DEFAULT_RETENTION
        );
      }
    }
    const chosen = retentionCandidates(
      runs,
      (scope) => policies.get(scope) ?? DEFAULT_RETENTION,
      this.#now()
    );
    const removed = this.#runs
      .prune([...chosen.values()].flat(), (run) => auditScope(run.correlation))
      .map((run) => run.id);
    const compaction = { gaps: this.#runs.gaps(), removed };
    if (removed.length > 0) {
      for (const listener of this.#listeners) {
        listener(compaction);
      }
    }
    return compaction;
  }
}
