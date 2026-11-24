import { type JobId, Queue, type RetryPolicy } from "@foundry/queue";
import { Effect, Layer } from "effect";
import { ScheduleDispatch } from "./dispatch";
import { DispatchError } from "./domain";

const isJobId = (id: string): id is JobId => id.startsWith("jb-");

const toDispatchError = (cause: unknown) => new DispatchError({ cause });

export const QueueDispatchLayer: Layer.Layer<ScheduleDispatch, never, Queue> =
  Layer.effect(
    ScheduleDispatch,
    Effect.map(Queue, (queue) =>
      ScheduleDispatch.of({
        cancel: (jobId, reason) =>
          isJobId(jobId)
            ? Effect.mapError(queue.cancel(jobId, reason), toDispatchError)
            : Effect.void,
        status: (jobId) =>
          isJobId(jobId)
            ? queue.getJob(jobId).pipe(
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
            : Effect.succeed("cancelled"),
        submit: (request) =>
          queue
            .submit({
              handler: request.target.handler,
              input: request.target.input,
              links: { source: "schedule", triggerId: request.scheduleId },
              policy: {
                idempotencyKey: request.idempotencyKey,
                ...(request.target.policy?.retry === undefined
                  ? {}
                  : { retry: request.target.policy.retry as RetryPolicy }),
                ...(request.target.policy?.timeoutMs === undefined
                  ? {}
                  : { timeoutMs: request.target.policy.timeoutMs }),
              },
              ...(request.target.pool === undefined
                ? {}
                : { pool: request.target.pool }),
            })
            .pipe(
              Effect.map((job) => ({ jobId: job.id })),
              Effect.mapError(toDispatchError)
            ),
      })
    )
  );
