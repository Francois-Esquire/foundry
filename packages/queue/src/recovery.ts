import {
  isGone,
  type ProcessIdentity,
  sameProcess,
} from "@foundry/lib/process-identity";
import { Clock, Effect } from "effect";
import type { Capacity } from "./capacity";
import type { RecoverySummary, Run, RunId } from "./domain";
import type { Ledger } from "./ledger";
import type { RecoverOptions } from "./service";
import type { Settlement } from "./settlement";
import { bump, claimOf } from "./transitions";

type Gone = (owner: ProcessIdentity) => boolean;

export const makeRecovery = (
  ledger: Ledger,
  settlement: Settlement,
  capacity: Capacity,
  self: ProcessIdentity
) => {
  const { commit, requireJob, store } = ledger;

  const interruptAbandoned = (gone: Gone) =>
    Effect.gen(function* () {
      const interrupted: RunId[] = [];
      for (const run of yield* store.listRuns({ state: "running" })) {
        if (run.state.kind !== "running") {
          continue;
        }
        const { owner } = run.state.lease;
        const abandoned = sameProcess(owner, self)
          ? !capacity.slots.has(run.id)
          : yield* Effect.sync(() => gone(owner));
        if (abandoned) {
          yield* settlement.interrupt(
            yield* requireJob(run.jobId),
            run,
            "owner gone"
          );
          interrupted.push(run.id);
        }
      }
      return interrupted;
    });

  const readmitQueued = (gone: Gone) =>
    Effect.gen(function* () {
      const readmitted: RunId[] = [];
      const adopted: Run[] = [];
      for (const run of yield* store.listRuns({ state: "queued" })) {
        const claim = yield* Effect.sync(() => claimOf(run, self, gone));
        if (claim === "skip" || run.state.kind !== "queued") {
          continue;
        }
        readmitted.push(run.id);
        if (claim === "adopt") {
          adopted.push(bump(run, { ...run.state, owner: self }));
        }
      }
      const now = yield* Clock.currentTimeMillis;
      yield* commit(now, { facts: [], write: { runs: adopted } });
      return readmitted;
    });

  const recover = (options: RecoverOptions = {}) =>
    Effect.gen(function* () {
      const gone = options.isOwnerGone ?? isGone;
      const interrupted = yield* interruptAbandoned(gone);
      const readmitted = yield* readmitQueued(gone);
      return { interrupted, readmitted } satisfies RecoverySummary;
    });

  const retire = (successor?: ProcessIdentity) =>
    Effect.gen(function* () {
      capacity.admission.retiring = true;
      if (successor === undefined) {
        return [];
      }
      const handedOver: Run[] = [];
      for (const run of yield* store.listRuns({ state: "queued" })) {
        if (!capacity.owns(run) || run.state.kind !== "queued") {
          continue;
        }
        const job = yield* store.getJob(run.jobId);
        if (job?.links.parentRunId === undefined) {
          handedOver.push(bump(run, { ...run.state, owner: successor }));
        }
      }
      const now = yield* Clock.currentTimeMillis;
      yield* commit(now, {
        facts: handedOver.map((run) => ({
          run,
          successor,
          type: "run.handed_over",
        })),
        write: { runs: handedOver },
      });
      return handedOver.map((run) => run.id);
    });

  return { recover, retire };
};
