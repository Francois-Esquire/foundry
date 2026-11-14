import type { ExecutionRun, ExecutionRuns } from "@foundry.sh/marbles/engine";
import { AsyncIteratorClass } from "@orpc/server";
import type { AuditEvent, AuditGap, AuditRun } from "~/shared/audit";
import type { Compaction, ExecutionRetention } from "./retention";

/**
 * The read side of Modules auditing: engine runs as the renderer reads
 * them. A watch starts with a snapshot of every retained run and gap, then
 * sends each change and each retention removal; reconnecting is a new
 * watch, so a fresh snapshot replaces what the reader held. Nothing here is
 * stored: runs are read straight from the engine.
 */

/** A run without its queued input or owning process. */
export function auditRun(run: ExecutionRun): AuditRun {
  const { input: _input, owner: _owner, ...rest } = run;
  return rest;
}

function auditGaps(runs: Pick<ExecutionRuns, "gaps">): AuditGap[] {
  return runs.gaps().map(({ removed, scope, through, updatedAt }) => ({
    removed,
    scope,
    through,
    updatedAt,
  }));
}

export interface ExecutionAuditOptions {
  readonly retention?: Pick<ExecutionRetention, "subscribe">;
  readonly runs: Pick<ExecutionRuns, "gaps" | "subscribe">;
}

export class ExecutionAudit {
  readonly #retention: ExecutionAuditOptions["retention"];
  readonly #runs: ExecutionAuditOptions["runs"];

  constructor(options: ExecutionAuditOptions) {
    this.#retention = options.retention;
    this.#runs = options.runs;
  }

  /**
   * The snapshot, then every change. Events wait in order, unbounded, for
   * a slow reader: dropping one would hide a change behind a later one.
   */
  watch(signal?: AbortSignal): AsyncIteratorClass<AuditEvent, void> {
    const queue: AuditEvent[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    const push = (event: AuditEvent) => {
      if (ended) {
        return;
      }
      queue.push(event);
      wake?.();
    };
    const subscription = this.#runs.subscribe((run) => {
      push({ run: auditRun(run), type: "run" });
    });
    // Taken in the same tick as the subscription: nothing falls between.
    push({
      gaps: auditGaps(this.#runs),
      runs: subscription.snapshot.map(auditRun),
      type: "snapshot",
    });
    const unsubscribeRetention = this.#retention?.subscribe(
      ({ removed }: Compaction) => {
        push({ gaps: auditGaps(this.#runs), ids: removed, type: "removed" });
      }
    );
    const end = () => {
      ended = true;
      subscription.unsubscribe();
      unsubscribeRetention?.();
      wake?.();
    };
    signal?.addEventListener("abort", end, { once: true });
    return new AsyncIteratorClass<AuditEvent, void>(
      async () => {
        while (queue.length === 0 && !ended) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
        const event = queue.shift();
        return event === undefined
          ? { done: true, value: undefined }
          : { done: false, value: event };
      },
      () => {
        end();
        signal?.removeEventListener("abort", end);
        return Promise.resolve();
      }
    );
  }
}
