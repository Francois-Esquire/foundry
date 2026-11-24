import type { Effect, Stream } from "effect";

import type { Bail, RunStatus } from "../types";
import type { WorkflowResult, WorkflowState } from "../workflow";

export interface WorkflowEffectAccess<I, O> {
  readonly cancel: (reason?: string) => Effect.Effect<void>;
  readonly markStarted: (at: string) => Effect.Effect<string>;
  readonly resolve: (name: string, value: unknown) => Effect.Effect<void>;
  readonly resolveOccurrence: (
    path: readonly string[],
    name: string,
    occurrence: number,
    value: unknown
  ) => Effect.Effect<void>;
  readonly result: Effect.Effect<WorkflowResult<O>>;
  readonly resume: (name: string, value: unknown) => Effect.Effect<void>;
  readonly resumeOccurrence: (
    path: readonly string[],
    name: string,
    occurrence: number,
    value: unknown
  ) => Effect.Effect<void>;
  readonly run: (
    input?: I,
    context?: object
  ) => Effect.Effect<O | Bail<unknown>, Error>;
  readonly seedState: (
    state: Partial<WorkflowState> & { status: RunStatus }
  ) => Effect.Effect<void>;
  readonly state: Effect.Effect<WorkflowState>;
  readonly stateChanges: Stream.Stream<WorkflowState>;
  readonly status: Effect.Effect<RunStatus>;
  readonly statusChanges: Stream.Stream<RunStatus>;
}

export const workflowEffectAccessKey: unique symbol = Symbol(
  "workflows.effect-access"
);
