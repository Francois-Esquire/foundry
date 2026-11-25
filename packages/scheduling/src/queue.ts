import { type Job, type JobId, Queue } from "@foundry/queue";
import { Clock, Effect, Layer } from "effect";
import { type DispatchStatus, ScheduleDispatch } from "./dispatch";
import { DispatchError, type Instant } from "./domain";

const toDispatchError = (cause: unknown) => new DispatchError({ cause });

const isJobId = (id: string): id is JobId => id.startsWith("jb-");

const jobIdOf = (id: string): Effect.Effect<JobId, DispatchError> =>
  isJobId(id)
    ? Effect.succeed(id)
    : Effect.fail(toDispatchError(`"${id}" is not a queue job id`));

const statusOf = (job: Job | undefined, now: Instant): DispatchStatus => {
  switch (job?.state.kind) {
    case "complete":
      return {
        kind: "settled",
        outcome: "complete",
        settledAt: job.state.completedAt,
      };
    case "failed":
      return {
        kind: "settled",
        outcome: "failed",
        settledAt: job.state.failedAt,
      };
    case "cancelled":
      return {
        kind: "settled",
        outcome: "cancelled",
        settledAt: job.state.cancelledAt,
      };
    case undefined:
      return { kind: "settled", outcome: "cancelled", settledAt: now };
    default:
      return { kind: "open" };
  }
};

export const QueueDispatchLayer: Layer.Layer<ScheduleDispatch, never, Queue> =
  Layer.effect(
    ScheduleDispatch,
    Effect.map(Queue, (queue) =>
      ScheduleDispatch.of({
        cancel: (jobId, reason) =>
          Effect.flatMap(jobIdOf(jobId), (id) =>
            Effect.mapError(queue.cancel(id, reason), toDispatchError)
          ),
        status: (jobId) =>
          Effect.flatMap(jobIdOf(jobId), (id) =>
            Effect.zipWith(
              Effect.mapError(queue.getJob(id), toDispatchError),
              Clock.currentTimeMillis,
              statusOf
            )
          ),
        submit: ({ idempotencyKey, scheduleId, target }) =>
          queue
            .submit({
              handler: target.handler,
              input: target.input,
              links: { source: "schedule", triggerId: scheduleId },
              policy: { ...target.policy, idempotencyKey },
              ...(target.pool === undefined ? {} : { pool: target.pool }),
            })
            .pipe(
              Effect.map((job) => ({ jobId: job.id })),
              Effect.mapError(toDispatchError)
            ),
      })
    )
  );
