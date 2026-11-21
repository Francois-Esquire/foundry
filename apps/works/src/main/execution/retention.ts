import { MODULE_SETTING_HOST_POLICY } from "@foundry/modules/settings";
import type {
  ExecutionRun,
  ExecutionRuns,
  RetentionGap,
} from "@foundry.sh/marbles/engine";
import { SETTLED_EXECUTION_STATUSES } from "@foundry.sh/marbles/statuses";
import { savedEvidence } from "~/shared/observations";

export const HOST_AUDIT_SCOPE = "host";

export interface RetentionPolicy {
  readonly maxTerminalEntries: number;
  readonly retentionDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  maxTerminalEntries:
    MODULE_SETTING_HOST_POLICY["audit.maxTerminalEntries"].default,
  retentionDays: MODULE_SETTING_HOST_POLICY["audit.retentionDays"].default,
};

const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export function auditScope(
  correlation: Readonly<Record<string, string | undefined>>
): string {
  const { moduleId } = correlation;
  return moduleId === undefined ? HOST_AUDIT_SCOPE : `module:${moduleId}`;
}

function checkpoints(run: ExecutionRun): string[] {
  return run.observations.flatMap((observation) => {
    const evidence = savedEvidence(observation);
    return evidence ? [`${evidence.artifactId}:${evidence.kind}`] : [];
  });
}

function protectedRuns(runs: readonly ExecutionRun[]): Set<string> {
  const latest = new Map<string, ExecutionRun>();
  const first = new Map<string, ExecutionRun>();
  for (const run of runs) {
    for (const checkpoint of checkpoints(run)) {
      const current = latest.get(checkpoint);
      if (!current || current.sequence < run.sequence) {
        latest.set(checkpoint, run);
      }
      const earliest = first.get(checkpoint);
      if (
        checkpoint.endsWith(":file") &&
        (!earliest || earliest.sequence > run.sequence)
      ) {
        first.set(checkpoint, run);
      }
    }
  }
  return new Set([...latest.values(), ...first.values()].map((run) => run.id));
}

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
  readonly policy?: (moduleId: string) => Promise<RetentionPolicy>;
  readonly runs: Pick<ExecutionRuns, "gaps" | "list" | "prune">;
}

export interface Compaction {
  readonly gaps: readonly RetentionGap[];
  readonly removed: readonly string[];
}

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

  subscribe(listener: (compaction: Compaction) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  compact(): Promise<Compaction> {
    const previous = this.#compacting ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.#compact());
    this.#compacting = next;
    return next;
  }

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
    const removed = (
      await this.#runs.prune([...chosen.values()].flat(), (run) =>
        auditScope(run.correlation)
      )
    ).map((run) => run.id);
    const compaction = { gaps: this.#runs.gaps(), removed };
    if (removed.length > 0) {
      for (const listener of this.#listeners) {
        listener(compaction);
      }
    }
    return compaction;
  }
}
