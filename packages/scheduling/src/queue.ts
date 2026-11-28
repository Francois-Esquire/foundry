import {
  cancelJob,
  enqueueJob,
  type Job,
  type JobId,
  Queue,
  type SubmitJobInput,
} from "@foundry/queue";
import type { QueueStoreService } from "@foundry/queue/store";
import { Clock, Effect, Layer } from "effect";
import {
  type DispatchStatus,
  ScheduleDispatch,
  type ScheduleDispatchService,
} from "./dispatch";
import { DispatchError, type Instant } from "./domain";

export interface QueueDispatchPort {
  readonly cancel: (id: JobId, reason?: string) => Effect.Effect<void, unknown>;
  readonly getJob: (id: JobId) => Effect.Effect<Job | undefined, unknown>;
  readonly submit: (input: SubmitJobInput) => Effect.Effect<Job, unknown>;
}

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

export const queueDispatchOver = (
  port: QueueDispatchPort
): ScheduleDispatchService =>
  ScheduleDispatch.of({
    cancel: (jobId, reason) =>
      Effect.flatMap(jobIdOf(jobId), (id) =>
        Effect.mapError(port.cancel(id, reason), toDispatchError)
      ),
    status: (jobId) =>
      Effect.flatMap(jobIdOf(jobId), (id) =>
        Effect.zipWith(
          Effect.mapError(port.getJob(id), toDispatchError),
          Clock.currentTimeMillis,
          statusOf
        )
      ),
    submit: ({ idempotencyKey, scheduleId, target }) =>
      port
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
  });

export const statelessQueueDispatch = (
  store: QueueStoreService
): ScheduleDispatchService =>
  queueDispatchOver({
    cancel: (id, reason) => cancelJob(store, id, reason),
    getJob: store.getJob,
    submit: (input) => enqueueJob(store, input),
  });

export const QueueDispatchLayer: Layer.Layer<ScheduleDispatch, never, Queue> =
  Layer.effect(ScheduleDispatch, Effect.map(Queue, queueDispatchOver));
