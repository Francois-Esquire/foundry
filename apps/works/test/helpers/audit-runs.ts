import { inject } from "vitest";
import { ExecutionAudit } from "~/main/execution/audit";
import type { AuditGap, AuditRun } from "~/shared/audit";

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
      subscribe: async (listener) => {
        listeners.add(listener as never);
        return {
          snapshot: [...state.runs.values()] as never,
          unsubscribe: () => listeners.delete(listener as never),
        };
      },
    },
  });
  return {
    audit: {
      watch: (signal?: AbortSignal) => {
        if (state.failNext > 0) {
          state.failNext -= 1;
          throw new Error("The run store is not reachable");
        }
        return audit.watch(signal);
      },
    },
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
