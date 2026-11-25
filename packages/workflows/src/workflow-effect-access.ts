import type { Effect } from "effect";
import type { TelemetryState } from "./telemetry";
import type { Bail } from "./types";
import type { WorkflowState } from "./workflow";

export interface WorkflowEffectAccess<I, O> {
  readonly cancel: (reason?: string) => Effect.Effect<void>;
  readonly restoreTelemetry: (telemetry: TelemetryState) => Effect.Effect<void>;
  readonly run: (
    input?: I,
    context?: object
  ) => Effect.Effect<O | Bail<unknown>, Error>;
  readonly state: Effect.Effect<WorkflowState>;
}

export const workflowEffectAccessKey: unique symbol = Symbol(
  "workflows.effect-access"
);
