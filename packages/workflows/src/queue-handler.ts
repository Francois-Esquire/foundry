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
import { Effect, Either, Fiber, Stream } from "effect";
import { z } from "zod";
import {
  type BaseContext,
  isSuspendSignal,
  type SuspendSignal,
  suspensionOccurrenceKey,
} from "./executable";
import { errorToShape } from "./helpers";
import { workflowEffectAccessKey } from "./internal/workflow-effect-access";
import { isJsonValue, isPlainRecord } from "./json-value";
import {
  SnapshotStateSchema,
  WorkflowSnapshotSchema,
  WorkflowTelemetrySchema,
} from "./schema";
import type { SnapshotState, StepSnapshot } from "./snapshot";
import type { Step } from "./step";
import { type Bail, isBail } from "./types";
import { Workflow, type WorkflowState } from "./workflow";

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

type Runnable<I, O, X extends BaseContext> = Step<I, O, X> | Workflow<I, O, X>;

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

const pruned = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(pruned);
  }
  if (!isPlainRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, field]) =>
      field === undefined ? [] : [[key, pruned(field)]]
    )
  );
};

const asJson = (
  value: unknown,
  what: string
): Effect.Effect<JsonValue, ErrorShape> => {
  const json = pruned(value);
  return isJsonValue(json)
    ? Effect.succeed(json)
    : Effect.fail({ message: `${what} is not a JSON value`, name: "not-json" });
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
  checkpoint: JsonValue | undefined
): Record<string, StepSnapshot> => {
  const parsed = WorkflowCheckpointSchema.safeParse(checkpoint);
  return parsed.success
    ? Object.fromEntries(
        Object.entries(parsed.data.steps).filter(([, step]) =>
          SETTLED.has(step.status)
        )
      )
    : {};
};

const progressOf = (state: SnapshotState) =>
  Object.entries(state.steps)
    .filter(([, step]) => SETTLED.has(step.status))
    .map(([key]) => key)
    .join("\n");

const suspendedOn = ({
  originPath,
  suspension,
}: SuspendSignal): RunOutcome => ({
  kind: "suspended",
  suspension: {
    key: suspensionOccurrenceKey(
      originPath,
      suspension.name,
      suspension.occurrence ?? 0
    ),
    kind: suspension.kind ?? "external",
    reason: suspension.reason,
    request: isJsonValue(suspension.request) ? suspension.request : null,
  },
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
    yield* root.snapshot.seed(settledSteps(context.checkpoint));
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
          ? suspendedOn(result.left)
          : yield* Effect.fail(errorToShape(result.left));
      }
      if (isBail(result.right)) {
        return bailedWith(result.right);
      }
      const output = transient
        ? null
        : yield* asJson(result.right ?? null, "workflow output");
      return { kind: "complete", output } satisfies RunOutcome;
    })
  );

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
