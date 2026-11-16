import type { Orchestrator } from "@foundry/workflows/orchestrator";

import type { Executions } from "~/lib/executions";
import type { FeedRouter } from "~/lib/feed/route";
import type { DispatchedRun } from "~/lib/launcher";
import { observeSteps } from "~/lib/observe";
import type { RunScopes } from "~/lib/run-scope";
import { TERMINAL_RUN_STATUSES } from "~/lib/run-store";
import { RunOutput } from "~/lib/state/output";

/** A run that ended without completing; the message says how and why. */
export class RunEndedError extends Error {
  override readonly name = "RunEndedError";
}

export type Dispatched<O> = Awaited<
  ReturnType<typeof Orchestrator.prototype.run<unknown, O>>
>;

/** The step events a workflow run's progress records: where it has got to, not each tick. */
const STEP_LIFECYCLE: ReadonlySet<string> = new Set([
  "step.started",
  "step.complete",
  "step.failed",
  "step.bailed",
  "step.skipped",
  "step.aborted",
]);

type DispatchedWorkflow = Dispatched<unknown>["workflow"];

interface HeldWorkflow {
  readonly root: Pick<DispatchedWorkflow["root"], "subscribe">;
  readonly state: DispatchedWorkflow["state"];
}

interface HeldRun {
  finalized?: Promise<unknown>;
  /**
   * None of it depends on the run's output type, which the workflow's
   * private runtime holds invariantly.
   */
  readonly workflow: HeldWorkflow;
}

export interface HeldRunsOptions {
  /** Where each run's progress, parks and resumes go on its Execution Run. */
  readonly executions: Pick<Executions, "progress" | "resume" | "suspend">;
  readonly orchestrator: Orchestrator;
  readonly print: (line: string) => void;
  readonly router: FeedRouter;
  readonly scopes: RunScopes;
  readonly state: string | undefined;
}

export class HeldRuns {
  readonly #options: HeldRunsOptions;
  readonly #held = new Map<string, HeldRun>();

  constructor(options: HeldRunsOptions) {
    this.#options = options;
    const { executions, orchestrator } = options;
    orchestrator.on("suspended", ({ runId }) => {
      if (this.#held.has(runId)) {
        executions.suspend(runId);
      }
    });
    orchestrator.on("resumed", ({ runId }) => {
      if (this.#held.has(runId)) {
        executions.resume(runId);
      }
    });
  }

  /** A held run's live workflow: its state and its stream. */
  workflow(runId: string): HeldWorkflow | undefined {
    return this.#held.get(runId)?.workflow;
  }

  /** Held runs whose workflow is in one of `statuses`. */
  withStatus(statuses: readonly string[]): readonly string[] {
    return [...this.#held]
      .filter(([, held]) => statuses.includes(held.workflow.state.status))
      .map(([runId]) => runId);
  }

  /**
   * Hold a dispatched or adopted run until it ends, for the launcher to
   * settle. A run left parked when the process stops has not ended: its
   * record stays suspended.
   */
  follow(name: string, dispatched: Dispatched<unknown>): DispatchedRun {
    const { orchestrator } = this.#options;
    return {
      cancel: async () => {
        await orchestrator.cancelRun(dispatched.id);
      },
      endedAs: () => {
        const { status } = dispatched.workflow.state;
        if (status === "cancelled") {
          return "cancelled";
        }
        return TERMINAL_RUN_STATUSES.has(status) ? "failed" : undefined;
      },
      result: this.#track(name, dispatched),
    };
  }

  #track<O>(name: string, dispatched: Dispatched<O>): Promise<O> {
    const { executions, print, router, scopes, state } = this.#options;
    const held: HeldRun = { workflow: dispatched.workflow };
    this.#held.set(dispatched.id, held);
    const output = new RunOutput(state, dispatched.id, name, print);
    const routed = router.observe(name, dispatched.id);
    const observing = new AbortController();
    const observed = observeSteps(name, dispatched.workflow, {
      onEvent: (event) => {
        routed.onEvent(event);
        if (STEP_LIFECYCLE.has(event._tag)) {
          executions.progress(dispatched.id, {
            event: event._tag,
            step: [name, ...event.path.slice(1)].join("."),
          });
        }
      },
      print,
      signal: observing.signal,
      write: (text) => output.text(text),
    });
    // The queue handle settles once its side effects are applied; the
    // workflow's own result carries the typed value.
    const complete = async () => {
      try {
        const [execution, observation] = await Promise.allSettled([
          dispatched.result().catch((error: unknown) => {
            observing.abort(error);
            throw error;
          }),
          observed,
        ]);
        await routed.settled();
        const settled = await dispatched.workflow.result();
        if (settled.status !== "complete") {
          const message =
            settled.status === "failed"
              ? `run "${name}" failed: ${settled.error.message}`
              : `run "${name}" was cancelled: ${settled.reason ?? router.cancelReason(dispatched.id) ?? "no reason"}`;
          await router.close(dispatched.id);
          throw new RunEndedError(message);
        }
        if (execution.status === "rejected") {
          throw execution.reason;
        }
        if (observation.status === "rejected") {
          throw observation.reason;
        }
        return settled.value;
      } finally {
        try {
          await scopes.settle(dispatched.id);
        } finally {
          this.#held.delete(dispatched.id);
        }
      }
    };
    const result = output.follow(
      complete(),
      () => dispatched.workflow.state.status === "cancelled"
    );
    held.finalized = result;
    // The host may attach after the first snapshot refresh.
    result.catch(() => undefined);
    return result;
  }

  async settle(): Promise<void> {
    await Promise.allSettled(
      [...this.#held.values()]
        .filter((held) => TERMINAL_RUN_STATUSES.has(held.workflow.state.status))
        .map((held) => held.finalized)
    );
  }
}
