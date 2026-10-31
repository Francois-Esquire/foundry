import { createHash } from "node:crypto";
import {
  ModuleGatewayError,
  type ModulePrincipal,
} from "@foundry/modules/gateway/types";
import { KeyedTurns } from "@foundry/modules/platform/turns";
import type { ExecutionRun } from "@foundry.sh/marbles/engine";
import {
  type ExecutionStatus,
  SETTLED_EXECUTION_STATUSES,
} from "@foundry.sh/marbles/statuses";
import { latest } from "~/main/platform/latest";
import type { WorksExecution } from "./contract";
import {
  WORKS_WORKFLOWS,
  type WorkflowModels,
  type WorkflowRegistry,
  workflowIdentity,
} from "./workflows";

/** How many finished runs' answers are kept for their watchers. */
const RETAINED_OUTPUTS = 200;

export interface WorkflowStart {
  readonly input: unknown;
  /** The caller's id for this start: resending it returns the same execution. */
  readonly request: string;
  readonly version: number;
  readonly workflow: string;
}

export interface WorkflowStarted {
  readonly execution: string;
  /** Answered from an earlier start of this request. */
  readonly retried: boolean;
  readonly status: ExecutionStatus;
}

/** One execution as its Module sees it. */
export interface WorkflowExecutionState {
  readonly error: { readonly code: string; readonly message?: string } | null;
  readonly execution: string;
  /** The workflow's answer once complete; null otherwise. */
  readonly output: unknown;
  readonly progress: unknown;
  readonly revision: number;
  readonly status: ExecutionStatus;
  readonly workflow: string;
}

export interface WorkflowExecutionEvent extends WorkflowExecutionState {
  readonly kind: "snapshot" | "update";
}

export interface ModuleWorkflowsOptions {
  readonly execution: Pick<WorksExecution, "cancel" | "launch" | "runs">;
  readonly models: WorkflowModels;
  readonly registry?: WorkflowRegistry;
}

const unavailable = () =>
  new ModuleGatewayError("unauthorized", "This execution is not available");

function isSettled(run: Pick<ExecutionRun, "status">): boolean {
  return SETTLED_EXECUTION_STATUSES.has(run.status);
}

/**
 * Module-started workflows (spec §7): each start of a host-registered
 * workflow is an engine run on the Module's `workflows` queue, correlated to
 * its Module, Installation and runtime. Only the runtime that started an
 * execution can watch or cancel it. Inputs and answers stay in this
 * process; the run carries their request identity and an input digest.
 */
export class ModuleWorkflows {
  readonly #execution: ModuleWorkflowsOptions["execution"];
  readonly #models: WorkflowModels;
  readonly #outputs = new Map<string, unknown>();
  readonly #registry: WorkflowRegistry;
  /** Starts and cancellations of one Installation, in order. */
  readonly #turns = new KeyedTurns<string>();

  constructor(options: ModuleWorkflowsOptions) {
    this.#execution = options.execution;
    this.#models = options.models;
    this.#registry = options.registry ?? WORKS_WORKFLOWS;
  }

  /**
   * Start a registered workflow. The run is durably queued, with the
   * request's identity and input digest, before the workflow does anything.
   * A request already started by this runtime with the same input answers
   * with that execution; with other input it is refused. `authorize`
   * re-checks the caller's Grant in turn with revocations.
   */
  start(
    principal: ModulePrincipal,
    start: WorkflowStart,
    authorize: () => Promise<void> = () => Promise.resolve()
  ): Promise<WorkflowStarted> {
    const identity = workflowIdentity(start.workflow, start.version);
    const workflow = this.#registry.get(identity);
    if (!workflow) {
      throw new ModuleGatewayError(
        "invalid-input",
        `${identity} is not a registered workflow`
      );
    }
    const parsed = workflow.input.safeParse(start.input);
    if (!parsed.success) {
      throw new ModuleGatewayError(
        "invalid-input",
        `The input for ${identity} is invalid`
      );
    }
    const input = parsed.data;
    const digest = createHash("sha256")
      .update(JSON.stringify({ input, workflow: identity }))
      .digest("hex");
    const { installationId, moduleId, runtimeInstanceId } = principal;
    return this.#turns.run(installationId, async () => {
      const earlier = this.#execution.runs
        .list()
        .find(
          (run) =>
            run.correlation.workflow !== undefined &&
            run.correlation.installationId === installationId &&
            run.correlation.request === start.request
        );
      if (earlier) {
        if (earlier.correlation.runtimeInstanceId !== runtimeInstanceId) {
          throw new ModuleGatewayError(
            "unauthorized",
            "This request was started by an earlier run of this app"
          );
        }
        if (earlier.correlation.input !== digest) {
          throw new ModuleGatewayError(
            "invalid-input",
            "This request was already used to start other work"
          );
        }
        return { execution: earlier.id, retried: true, status: earlier.status };
      }
      await authorize();
      const { id, result } = await this.#execution.launch(
        identity,
        {
          correlation: {
            input: digest,
            installationId,
            moduleId,
            request: start.request,
            runtimeInstanceId,
            workflow: identity,
          },
          queue: { kind: "workflows", moduleId },
        },
        async (context) => {
          const output = await workflow.run(input, {
            models: this.#models,
            progress: (value) => context.progress(value),
            signal: context.signal,
            task: context,
          });
          // Held before the run settles, so a watcher that sees `complete`
          // also sees the answer.
          this.#remember(context.run.id, output);
          return output;
        }
      );
      result.catch(() => undefined);
      return {
        execution: id,
        retried: false,
        status: this.#execution.runs.get(id)?.status ?? "queued",
      };
    });
  }

  /**
   * The caller's execution: a snapshot, then each newer revision (changes
   * that arrive while the reader is busy collapse into the latest), ending
   * once it settles or the request is cancelled. Reconnecting starts again
   * from a fresh snapshot.
   */
  async *watch(
    principal: ModulePrincipal,
    id: string,
    signal: AbortSignal
  ): AsyncGenerator<WorkflowExecutionEvent, void> {
    this.#owned(principal, id);
    const { runs } = this.#execution;
    let kind: WorkflowExecutionEvent["kind"] = "snapshot";
    for await (const run of latest({
      read: () => runs.get(id),
      same: (sent, next) => next.revision <= sent.revision,
      signal,
      subscribe(changed) {
        const subscription = runs.subscribe((changedRun) => {
          if (changedRun.id === id) {
            changed();
          }
        });
        return () => subscription.unsubscribe();
      },
    })) {
      yield { kind, ...this.#state(run) };
      kind = "update";
      if (isSettled(run)) {
        return;
      }
    }
  }

  /** Cancel the caller's execution through the engine; settled runs stay as they are. */
  async cancel(
    principal: ModulePrincipal,
    id: string
  ): Promise<{ status: ExecutionStatus }> {
    const run = this.#owned(principal, id);
    if (!isSettled(run)) {
      await this.#execution.cancel(id);
    }
    return { status: this.#execution.runs.get(id)?.status ?? run.status };
  }

  /**
   * Cancel every unfinished execution of an Installation: its start Grant
   * was revoked or its Program stopped. Ordered after any start in flight.
   */
  cancelInstallation(installationId: string): Promise<void> {
    return this.#turns.run(installationId, () =>
      this.#cancelOpen(
        (run) => run.correlation.installationId === installationId
      )
    );
  }

  /** Quit: no Program outlives Works, so neither does work they started. */
  shutdown(): Promise<void> {
    return this.#cancelOpen(() => true);
  }

  async #cancelOpen(matches: (run: ExecutionRun) => boolean) {
    const open = this.#execution.runs
      .list()
      .filter(
        (run) =>
          run.correlation.workflow !== undefined &&
          !isSettled(run) &&
          matches(run)
      );
    await Promise.all(
      open.map((run) => this.#execution.cancel(run.id).catch(() => undefined))
    );
  }

  /** The run, if it is a workflow this runtime started; otherwise the same refusal as for an unknown id. */
  #owned(principal: ModulePrincipal, id: string): ExecutionRun {
    const run = this.#execution.runs.get(id);
    if (
      !run ||
      run.correlation.workflow === undefined ||
      run.correlation.installationId !== principal.installationId ||
      run.correlation.runtimeInstanceId !== principal.runtimeInstanceId
    ) {
      throw unavailable();
    }
    return run;
  }

  #remember(id: string, output: unknown) {
    this.#outputs.set(id, output);
    for (const key of this.#outputs.keys()) {
      if (this.#outputs.size <= RETAINED_OUTPUTS) {
        break;
      }
      this.#outputs.delete(key);
    }
  }

  #state(run: ExecutionRun): WorkflowExecutionState {
    return {
      error:
        run.status === "complete" || run.error === undefined
          ? null
          : {
              code: run.error.code,
              ...(run.status === "failed" && run.error.message !== undefined
                ? { message: run.error.message }
                : {}),
            },
      execution: run.id,
      output:
        run.status === "complete" ? (this.#outputs.get(run.id) ?? null) : null,
      progress: run.progress ?? null,
      revision: run.revision,
      status: run.status,
      workflow: run.name,
    };
  }
}
