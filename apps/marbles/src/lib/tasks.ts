import type { JsonValue } from "@foundry/lib/json";
import type { Container } from "@foundry/sandbox/container/containers";

import type { ExecutionRun, HostObservation } from "~/lib/executions";
import type { Agents, SandboxHandle } from "~/lib/types";

/**
 * Host tasks: run kinds that are not workflow definitions, such as a save, a
 * build, a publish, an import, a settings change, or a Program's lifetime.
 * A host registers one with `engine.task` and launches it by name like any
 * definition; it waits in its queue, and its record carries what it reports.
 * The body calls the host's own services. Its return value is handed back
 * to the caller and never stored; what the run did goes on its record as
 * typed observations.
 */

/** An observation a task reports; its id and times are filled in when omitted. */
export type TaskObservation = Omit<
  HostObservation,
  "id" | "startedAt" | "status"
> &
  Partial<Pick<HostObservation, "id" | "startedAt" | "status">>;

export interface TaskContext {
  /**
   * Sessions that work in the workspace root, stop when the run is
   * cancelled, close when it settles, and record their model turns and tool
   * calls on this run.
   */
  readonly agents: Agents;
  /**
   * Record or replace an observation on this run. Returns whether it was
   * durably recorded: a failed write keeps it only in this process.
   */
  observe(observation: TaskObservation): boolean;
  /** Record where the run has got to; the latest replaces the last. */
  progress(value: JsonValue): void;
  /**
   * Give up the queue slot while the run goes on: a long-lived run, such as
   * a Program's lifetime, calls this once it has started, so later work on
   * its queue is not held up. It stays `running` until its body returns,
   * and is `interrupted` if its process dies first.
   */
  release(): void;
  /** The run as it was admitted: its id, queue and correlation. */
  readonly run: ExecutionRun;
  /**
   * Lend the run a container the host owns, as a handle a session's
   * `sandbox` option accepts: the harness and its tools work inside it.
   * Closing the handle leaves the container running for its owner.
   */
  sandbox(container: Container): SandboxHandle;
  /** Aborted when the run is cancelled or the engine stops. */
  readonly signal: AbortSignal;
}

export interface TaskDefinition<I = unknown, O = unknown> {
  readonly name: string;
  /** The queue it joins when a launch names none; the engine's default otherwise. */
  readonly queue?: string;
  /**
   * The work. Returning completes the run; throwing fails it; once the run
   * is cancelled, either way it is recorded `cancelled`.
   */
  run(input: I, context: TaskContext): Promise<O> | O;
}
