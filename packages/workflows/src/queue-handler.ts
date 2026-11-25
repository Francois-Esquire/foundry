import type { JsonValue } from "@foundry/lib/json";
import type {
  ErrorShape,
  Job,
  Run,
  RunContext,
  RunHandler,
  RunId,
  RunOutcome,
} from "@foundry/queue";
import { Data, Effect, Either, Fiber, Stream } from "effect";
import { z } from "zod";
import type { Runnable } from "./definitions";
import { errorToShape } from "./effect-interop";
import { isJsonValue, isPlainRecord } from "./json-value";
import {
  SnapshotStateSchema,
  WorkflowSnapshotSchema,
  WorkflowTelemetrySchema,
} from "./schema";
import {
  type BaseContext,
  isSuspendSignal,
  type SuspendSignal,
  suspensionOccurrenceKey,
} from "./slices/executable";
import type { SnapshotState, StepSnapshot } from "./slices/snapshot";
import { type Bail, isBail } from "./types";
import { Workflow, type WorkflowResult, type WorkflowState } from "./workflow";
import { workflowEffectAccessKey } from "./workflow-effect-access";

export const WorkflowCheckpointSchema = z.object({
  steps: SnapshotStateSchema.shape.steps,
  telemetry: WorkflowTelemetrySchema.optional(),
  tree: WorkflowSnapshotSchema.nullable(),
});

export type WorkflowCheckpoint = z.infer<typeof WorkflowCheckpointSchema>;

export interface WorkflowExecution {
  readonly job: Job;
  readonly run: Run;
}

export type WorkflowRunFactory<
  I = unknown,
  O = unknown,
  X extends BaseContext = BaseContext,
> = (
  input: JsonValue,
  execution: WorkflowExecution
) => Runnable<I, O, X> | Promise<Runnable<I, O, X>>;

export interface WorkflowHandlerOptions<
  I = unknown,
  O = unknown,
  X extends BaseContext = BaseContext,
> {
  readonly onFinish?: (runId: RunId, workflow: Workflow<I, O, X>) => void;
  readonly onStart?: (runId: RunId, workflow: Workflow<I, O, X>) => void;
}

const SETTLED: ReadonlySet<StepSnapshot["status"]> = new Set([
  "complete",
  "skipped",
]);

const pruned = (value: unknown, seen = new Set<object>()): unknown => {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    seen.add(value);
    const result = value.map((item) => pruned(item, seen));
    seen.delete(value);
    return result;
  }
  if (!isPlainRecord(value)) {
    return value;
  }
  seen.add(value);
  const result = Object.fromEntries(
    Object.entries(value).flatMap(([key, field]) =>
      field === undefined ? [] : [[key, pruned(field, seen)]]
    )
  );
  seen.delete(value);
  return result;
};

class NotJsonError extends Data.TaggedError("NotJsonError")<{
  readonly what: string;
}> {}

const asJson = (
  value: unknown,
  what: string
): Effect.Effect<JsonValue, NotJsonError> => {
  const json = pruned(value);
  return isJsonValue(json)
    ? Effect.succeed(json)
    : Effect.fail(new NotJsonError({ what }));
};

const checkpointOf = (
  state: SnapshotState,
  telemetry: WorkflowState["telemetry"],
  transient: boolean
) =>
  asJson(
    {
      steps: Object.fromEntries(
        Object.entries(state.steps).map(([key, { output, ...step }]) => [
          key,
          transient ? step : { ...step, output },
        ])
      ),
      telemetry,
      tree: state.workflow,
    },
    "workflow checkpoint"
  );

const settledSteps = (
  checkpoint: WorkflowCheckpoint | undefined
): Record<string, StepSnapshot> =>
  Object.fromEntries(
    Object.entries(checkpoint?.steps ?? {}).filter(([, step]) =>
      SETTLED.has(step.status)
    )
  );

const progressOf = (state: SnapshotState) =>
  Object.entries(state.steps)
    .filter(([, step]) => SETTLED.has(step.status))
    .map(([key]) => key)
    .join("\n");

const suspendedOn = ({ originPath, suspension }: SuspendSignal) =>
  Effect.map(
    asJson(suspension.request ?? null, "suspension request"),
    (request): RunOutcome => ({
      kind: "suspended",
      suspension: {
        key: suspensionOccurrenceKey(
          originPath,
          suspension.name,
          suspension.occurrence ?? 0
        ),
        kind: suspension.kind ?? "external",
        reason: suspension.reason,
        request,
      },
    })
  );

const notJson = ({ what }: NotJsonError): RunOutcome => ({
  error: { message: `${what} is not a JSON value`, name: "not-json" },
  kind: "bailed",
});

const bailedWith = ({ error }: Bail<unknown>): RunOutcome => ({
  error: {
    message:
      typeof error === "string" ? error : (JSON.stringify(error) ?? "bailed"),
    name: "bailed",
  },
  kind: "bailed",
});

const materialize = <I, O, X extends BaseContext>(
  factory: WorkflowRunFactory<I, O, X>,
  { job, run }: RunContext
) =>
  Effect.tryPromise({
    catch: errorToShape,
    try: async () => {
      const made = await factory(job.input, { job, run });
      return made.kind === "step" ? Workflow.attach(made, made.input) : made;
    },
  });

const hydrate = <I, O, X extends BaseContext>(
  workflow: Workflow<I, O, X>,
  context: Pick<RunContext, "checkpoint" | "resolutions">
) =>
  Effect.gen(function* () {
    const root = yield* Effect.try({
      catch: errorToShape,
      try: () => workflow.root,
    });
    const parsed = WorkflowCheckpointSchema.safeParse(context.checkpoint);
    const checkpoint = parsed.success ? parsed.data : undefined;
    yield* root.snapshot.seed(settledSteps(checkpoint));
    if (checkpoint?.telemetry !== undefined) {
      yield* workflow[workflowEffectAccessKey]().restoreTelemetry(
        checkpoint.telemetry
      );
    }
    yield* Effect.forEach(
      context.resolutions,
      ([key, value]) => root.executable.resolve(key, value),
      { discard: true }
    );
  });

const drive = <I, O, X extends BaseContext>(
  workflow: Workflow<I, O, X>,
  context: RunContext
): Effect.Effect<RunOutcome, ErrorShape> =>
  Effect.scoped(
    Effect.gen(function* () {
      const access = workflow[workflowEffectAccessKey]();
      const transient = workflow.persistence.results === "transient";
      const save = (state: SnapshotState) =>
        Effect.flatMap(access.state, ({ telemetry }) =>
          Effect.flatMap(
            checkpointOf(state, telemetry, transient),
            (checkpoint) =>
              Effect.mapError(context.saveCheckpoint(checkpoint), errorToShape)
          )
        );
      const hydrated = progressOf(yield* workflow.root.snapshot.current);
      const streaming = yield* workflow.root.snapshot.changes.pipe(
        Stream.changesWith(
          (one, other) => progressOf(one) === progressOf(other)
        ),
        Stream.filter((state) => progressOf(state) !== hydrated),
        Stream.runForEach((state) =>
          save(state).pipe(
            Effect.catchAll((failure) =>
              Effect.logWarning("workflow checkpoint not saved", failure)
            )
          )
        ),
        Effect.forkScoped
      );
      const result = yield* access.run().pipe(
        Effect.either,
        Effect.onInterrupt(() => access.cancel("cancelled"))
      );
      yield* Fiber.interrupt(streaming);
      yield* Effect.flatMap(workflow.root.snapshot.current, save);
      if (Either.isLeft(result)) {
        return isSuspendSignal(result.left)
          ? yield* suspendedOn(result.left)
          : yield* Effect.fail(errorToShape(result.left));
      }
      if (isBail(result.right)) {
        return bailedWith(result.right);
      }
      const output = transient
        ? null
        : yield* asJson(result.right ?? null, "workflow output");
      return { kind: "complete", output } satisfies RunOutcome;
    }).pipe(
      Effect.catchIf(
        (error): error is NotJsonError => error instanceof NotJsonError,
        (error) => Effect.succeed(notJson(error))
      )
    )
  );

export const runResultOf = ({ state }: Run): WorkflowResult<unknown> => {
  switch (state.kind) {
    case "complete":
      return { status: "complete", value: state.output };
    case "failed":
      return { error: new Error(state.error.message), status: "failed" };
    case "interrupted":
      return { error: new Error(state.reason), status: "failed" };
    case "cancelled":
      return state.reason === undefined
        ? { status: "cancelled" }
        : { reason: state.reason, status: "cancelled" };
    default:
      return { status: "cancelled" };
  }
};

export const restoreWorkflow = <I, O, X extends BaseContext>(
  workflow: Workflow<I, O, X>,
  checkpoint: JsonValue | undefined
): Promise<void> =>
  Effect.runPromise(
    hydrate(workflow, { checkpoint, resolutions: new Map() }).pipe(
      Effect.mapError((failure) => new Error(failure.message))
    )
  );

export const workflowHandler =
  <I, O, X extends BaseContext = BaseContext>(
    factory: WorkflowRunFactory<I, O, X>,
    options: WorkflowHandlerOptions<I, O, X> = {}
  ): RunHandler =>
  (context) =>
    Effect.gen(function* () {
      const workflow = yield* materialize(factory, context);
      yield* hydrate(workflow, context);
      yield* Effect.sync(() => options.onStart?.(context.run.id, workflow));
      return yield* drive(workflow, context).pipe(
        Effect.ensuring(
          Effect.sync(() => options.onFinish?.(context.run.id, workflow))
        )
      );
    });
