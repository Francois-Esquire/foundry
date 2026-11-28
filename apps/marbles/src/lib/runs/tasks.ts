import type { JsonValue } from "@foundry/lib/json";
import type { Container } from "@foundry/sandbox";
import type { Agents, SandboxHandle } from "~/lib/definitions/types";
import type { ExecutionRun, HostObservation } from "~/lib/executions";

export type TaskObservation = Omit<
  HostObservation,
  "id" | "startedAt" | "status"
> &
  Partial<Pick<HostObservation, "id" | "startedAt" | "status">>;

export interface TaskContext {
  readonly agents: Agents;
  observe(observation: TaskObservation): Promise<boolean>;
  progress(value: JsonValue): void;
  readonly run: ExecutionRun;
  sandbox(container: Container): SandboxHandle;
  readonly signal: AbortSignal;
}

export interface TaskDefinition<I = unknown, O = unknown> {
  readonly name: string;
  readonly pool?: string;
  run(input: I, context: TaskContext): Promise<O> | O;
}
