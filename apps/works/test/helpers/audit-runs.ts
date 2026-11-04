import { inject } from "vitest";
import { ExecutionAudit } from "~/main/execution/audit";
import type { AuditGap, AuditRun } from "~/shared/audit";

/**
 * The run store the global setup recorded through the real engine, served
 * to the renderer through the real audit service and router. Tests can
 * announce a later change, add a retention gap, or make the next watch
 * fail, as main would.
 */
export function fixtureAudit() {
  const fixture = inject("auditFixture");
  const listeners = new Set<(run: AuditRun) => void>();
  const state = {
    failNext: 0,
    gaps: [...fixture.gaps] as AuditGap[],
    runs: new Map(fixture.runs.map((run) => [run.id, run])),
  };
  const audit = new ExecutionAudit({
    runs: {
      gaps: () => state.gaps as never,
      subscribe: (listener) => {
        listeners.add(listener as never);
        return {
          snapshot: [...state.runs.values()] as never,
          unsubscribe: () => listeners.delete(listener as never),
        };
      },
    },
  });
  return {
    /** What the router's `audit` service is. */
    audit: {
      watch: (signal?: AbortSignal) => {
        if (state.failNext > 0) {
          state.failNext -= 1;
          throw new Error("The run store is not reachable");
        }
        return audit.watch(signal);
      },
    },
    /** A run changed in main. */
    change(run: AuditRun) {
      state.runs.set(run.id, run);
      for (const listener of listeners) {
        listener(run);
      }
    },
    fixture,
    listeners,
    state,
  };
}
