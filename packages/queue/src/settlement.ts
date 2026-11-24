import type { JsonValue } from "@foundry/lib/json";
import type { ProcessIdentity } from "@foundry/lib/process-identity";
import { Cause, Clock, Effect, Exit, Option } from "effect";
import type {
  ErrorShape,
  Instant,
  Job,
  Run,
  RunId,
  RunOutcome,
  Suspension,
  SuspensionRequest,
} from "./domain";
import { type Ledger, newId } from "./ledger";
import { nextAttemptAt } from "./retry";
import {
  completion,
  type FollowUp,
  failedJob,
  failure,
  interruption,
  type QueuedRunInput,
  queuedRun,
  retrying,
  suspending,
} from "./transitions";

const errorShapeOf = (cause: Cause.Cause<ErrorShape>): ErrorShape =>
  Option.getOrElse(Cause.failureOption(cause), () => ({
    message: Cause.pretty(cause),
    name: "defect",
  }));

export const makeSettlement = (ledger: Ledger, self: ProcessIdentity) => {
  const { commit, store } = ledger;

  const newRun = (
    input: Omit<QueuedRunInput, "id" | "owner">,
    chosen?: RunId
  ) =>
    Effect.map(
      chosen === undefined ? newId("rn") : Effect.succeed(chosen),
      (id) => queuedRun({ ...input, id, owner: self })
    );

  const followUp = (job: Job, ended: Run, error: ErrorShape, now: Instant) =>
    Effect.gen(function* () {
      const retryAt = yield* nextAttemptAt(job, ended.attempt, now);
      if (retryAt === undefined) {
        return failedJob({ error, job, now, run: ended });
      }
      const retry = yield* newRun({
        at: retryAt,
        attempt: ended.attempt + 1,
        jobId: job.id,
        now,
        pool: ended.pool,
        ...(ended.checkpoint === undefined
          ? {}
          : { checkpoint: ended.checkpoint }),
      });
      return retrying(job, retry);
    });

  const fail = (job: Job, run: Run, error: ErrorShape, retryable: boolean) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const next: FollowUp = retryable
        ? yield* followUp(job, run, error, now)
        : failedJob({ error, job, now, run });
      yield* commit(now, failure({ error, next, now, run }));
    });

  const interrupt = (job: Job, run: Run, reason: string) =>
    Effect.gen(function* () {
      const { state } = run;
      if (state.kind !== "running") {
        return;
      }
      const now = yield* Clock.currentTimeMillis;
      const next = yield* followUp(
        job,
        run,
        { message: reason, name: "interrupted" },
        now
      );
      yield* commit(
        now,
        interruption({ next, now, reason, run: { ...run, state } })
      );
    });

  const complete = (job: Job, run: Run, output: JsonValue) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      commit(now, completion({ job, now, output, run }))
    );

  const suspend = (job: Job, run: Run, request: SuspensionRequest) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const pending = yield* store.listSuspensions({
        runId: run.id,
        state: "pending",
      });
      const existing = pending.find((open) => open.key === request.key);
      const suspension: Suspension = existing ?? {
        ...request,
        id: yield* newId("su"),
        revision: 0,
        runId: run.id,
        state: { createdAt: now, kind: "pending" },
      };
      yield* commit(
        now,
        suspending({
          job,
          now,
          opened: existing === undefined,
          run,
          suspension,
        })
      );
    });

  const conclude = (
    job: Job,
    run: Run,
    exit: Exit.Exit<RunOutcome, ErrorShape>
  ) => {
    if (Exit.isFailure(exit)) {
      return Cause.isInterruptedOnly(exit.cause)
        ? Effect.void
        : fail(job, run, errorShapeOf(exit.cause), true);
    }
    const outcome = exit.value;
    switch (outcome.kind) {
      case "complete":
        return complete(job, run, outcome.output);
      case "suspended":
        return suspend(job, run, outcome.suspension);
      case "bailed":
        return fail(job, run, outcome.error, false);
      default:
        return Effect.dieMessage(
          `unknown run outcome ${JSON.stringify(outcome satisfies never)}`
        );
    }
  };

  return { conclude, fail, interrupt, newRun };
};

export type Settlement = ReturnType<typeof makeSettlement>;
