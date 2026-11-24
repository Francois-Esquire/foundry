import { type JobId, Queue } from "@foundry/queue";
import { Effect, Layer } from "effect";
import { ScheduleDispatch } from "./dispatch";
import { DispatchError } from "./domain";

const toDispatchError = (cause: unknown) => new DispatchError({ cause });

const isJobId = (id: string): id is JobId => id.startsWith("jb-");

const jobIdOf = (id: string): Effect.Effect<JobId, DispatchError> =>
  isJobId(id)
    ? Effect.succeed(id)
    : Effect.fail(toDispatchError(`"${id}" is not a queue job id`));

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
            queue.getJob(id).pipe(
              Effect.map((job) => {
                switch (job?.state.kind) {
                  case "complete":
                  case "failed":
                  case "cancelled":
                    return job.state.kind;
                  case undefined:
                    return "cancelled";
                  default:
                    return "open";
                }
              }),
              Effect.mapError(toDispatchError)
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
