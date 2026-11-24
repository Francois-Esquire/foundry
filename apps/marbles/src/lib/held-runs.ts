import type { Executions } from "~/lib/executions";
import type { FeedRouter } from "~/lib/feed/route";
import type { DispatchedRun } from "~/lib/launcher";
import { observeSteps } from "~/lib/observe";
import type { RunScopes } from "~/lib/run-scope";
import { TERMINAL_RUN_STATUSES } from "~/lib/run-store";
import { RunOutput } from "~/lib/state/output";
import type {
  LiveRun,
  HeldWorkflow as LiveWorkflow,
  WorkflowQueue,
} from "~/lib/workflow-queue";

export class RunEndedError extends Error {
  override readonly name = "RunEndedError";
}

const STEP_LIFECYCLE: ReadonlySet<string> = new Set([
  "step.started",
  "step.complete",
  "step.failed",
  "step.bailed",
  "step.skipped",
  "step.aborted",
]);

interface HeldWorkflow {
  readonly root: Pick<LiveWorkflow["root"], "subscribe">;
  readonly state: LiveWorkflow["state"];
}

interface HeldRun {
  finalized?: Promise<unknown>;
  readonly workflow: HeldWorkflow;
}

export interface HeldRunsOptions {
  readonly executions: Pick<Executions, "progress" | "resume" | "suspend">;
  readonly print: (line: string) => void;
  readonly queue: WorkflowQueue;
  readonly router: FeedRouter;
  readonly scopes: RunScopes;
  readonly state: string | undefined;
}

export class HeldRuns {
  readonly #options: HeldRunsOptions;
  readonly #held = new Map<string, HeldRun>();

  constructor(options: HeldRunsOptions) {
    this.#options = options;
    const { executions, queue } = options;
    queue.on("suspended", (runId) => {
      if (this.#held.has(runId)) {
        executions.suspend(runId);
      }
    });
    queue.on("resumed", (runId) => {
      if (this.#held.has(runId)) {
        executions.resume(runId);
      }
    });
  }

  workflow(runId: string): HeldWorkflow | undefined {
    return this.#held.get(runId)?.workflow;
  }

  withStatus(statuses: readonly string[]): readonly string[] {
    return [...this.#held]
      .filter(([, held]) => statuses.includes(held.workflow.state.status))
      .map(([runId]) => runId);
  }

  follow(name: string, dispatched: LiveRun): DispatchedRun {
    const { queue } = this.#options;
    return {
      cancel: async () => {
        await queue.cancelRun(dispatched.id);
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

  #track(name: string, dispatched: LiveRun): Promise<unknown> {
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
      write: (text, chunk) => output.text(text, chunk),
    });
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
        if (execution.status === "rejected") {
          throw execution.reason;
        }
        const settled = execution.value;
        if (settled.status !== "complete") {
          const message =
            settled.status === "failed"
              ? `run "${name}" failed: ${settled.error.message}`
              : `run "${name}" was cancelled: ${settled.reason ?? router.cancelReason(dispatched.id) ?? "no reason"}`;
          await router.close(dispatched.id);
          throw new RunEndedError(message);
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
