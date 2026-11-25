import { instanceGone, sameInstance } from "@foundry/lib/instance-identity";
import { isGone } from "@foundry/lib/node/process-identity";
import { Clock, Effect } from "effect";
import type { Capacity } from "./capacity";
import type { QueueOwner, RecoverySummary, Run, RunId } from "./domain";
import type { Ledger } from "./ledger";
import type { RecoverOptions } from "./service";
import type { Settlement } from "./settlement";
import { bump, claimOf } from "./transitions";

type Gone = (owner: QueueOwner) => boolean;

const unowned = (run: Run): Run => {
  if (run.state.kind !== "queued") {
    return run;
  }
  const { owner: _owner, ...state } = run.state;
  return bump(run, state);
};

export const makeRecovery = (
  ledger: Ledger,
  settlement: Settlement,
  capacity: Capacity,
  self: QueueOwner
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
        const abandoned = sameInstance(owner, self)
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

  const adoptQueued = (gone: Gone) =>
    Effect.gen(function* () {
      const adopted: RunId[] = [];
      const updated: Run[] = [];
      for (const run of yield* store.listRuns({ state: "queued" })) {
        const claim = yield* Effect.sync(() => claimOf(run, self, gone));
        if (claim === "skip" || run.state.kind !== "queued") {
          continue;
        }
        adopted.push(run.id);
        if (claim === "adopt") {
          updated.push(bump(run, { ...run.state, owner: self }));
        }
      }
      const now = yield* Clock.currentTimeMillis;
      yield* commit(now, { facts: [], write: { runs: updated } });
      return adopted;
    });

  const recover = (options: RecoverOptions = {}) =>
    Effect.gen(function* () {
      const processGone = options.isOwnerGone ?? isGone;
      const gone: Gone = (owner) => instanceGone(owner, self, processGone);
      const interrupted = yield* interruptAbandoned(gone);
      const adopted = yield* adoptQueued(gone);
      return { adopted, interrupted } satisfies RecoverySummary;
    });

  const runsBesideRunningParent = (run: Run) =>
    Effect.map(store.getJob(run.jobId), (job) => {
      const parent = job?.links.parentRunId;
      return parent !== undefined && capacity.slots.has(parent);
    });

  const retire = (successor?: QueueOwner) =>
    Effect.gen(function* () {
      capacity.admission.retiring = true;
      const owned = (yield* store.listRuns({ state: "queued" })).filter((run) =>
        capacity.ownedBySelf(run)
      );
      const handed: Run[] = [];
      for (const run of owned) {
        if (
          run.state.kind !== "queued" ||
          (yield* runsBesideRunningParent(run))
        ) {
          continue;
        }
        handed.push(
          successor === undefined
            ? unowned(run)
            : bump(run, { ...run.state, owner: successor })
        );
      }
      const now = yield* Clock.currentTimeMillis;
      yield* commit(now, {
        facts:
          successor === undefined
            ? []
            : handed.map((run) => ({
                run,
                successor,
                type: "run.handed_over" as const,
              })),
        write: { runs: handed },
      });
      return handed.map((run) => run.id);
    });

  return { recover, retire };
};
