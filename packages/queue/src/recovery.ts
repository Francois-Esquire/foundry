import { instanceGone, sameInstance } from "@foundry/lib/instance-identity";
import { isGone } from "@foundry/lib/process-identity";
import { Clock, Effect } from "effect";
import type { Capacity } from "./capacity";
import type { QueueOwner, RecoverySummary, Run, RunId } from "./domain";
import type { Ledger } from "./ledger";
import type { RecoverOptions } from "./service";
import type { Settlement } from "./settlement";
import { bump, claimOf } from "./transitions";

type Gone = (owner: QueueOwner) => boolean;

const released = (run: Run): Run => {
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
      const processGone = options.isOwnerGone ?? isGone;
      const gone: Gone = (owner) => instanceGone(owner, self, processGone);
      const interrupted = yield* interruptAbandoned(gone);
      const readmitted = yield* readmitQueued(gone);
      return { interrupted, readmitted } satisfies RecoverySummary;
    });

  const retire = (successor?: QueueOwner) =>
    Effect.gen(function* () {
      capacity.admission.retiring = true;
      const pinned = (yield* store.listRuns({ state: "queued" })).filter(
        (run) => capacity.pins(run)
      );
      const given = pinned.flatMap((run) => {
        if (run.state.kind !== "queued") {
          return [];
        }
        return [
          successor === undefined
            ? released(run)
            : bump(run, { ...run.state, owner: successor }),
        ];
      });
      const now = yield* Clock.currentTimeMillis;
      yield* commit(now, {
        facts:
          successor === undefined
            ? []
            : given.map((run) => ({
                run,
                successor,
                type: "run.handed_over" as const,
              })),
        write: { runs: given },
      });
      return given.map((run) => run.id);
    });

  return { recover, retire };
};
