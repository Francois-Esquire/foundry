import type { Orchestrator } from "@foundry/workflows/orchestrator";
import type { InMemoryOrchestratorStore } from "@foundry/workflows/store";

import type { Executions } from "~/lib/executions";
import type { FeedRouter } from "~/lib/feed/route";
import type { DispatchedRun } from "~/lib/launcher";
import { observeSteps } from "~/lib/observe";
import type { RunScopes } from "~/lib/run-scope";
import type { Lock } from "~/lib/state/locks";
import { RunOutput } from "~/lib/state/output";
import type { RunExtras } from "~/lib/state/runs";
import { saveRun, TERMINAL_RUN_STATUSES } from "~/lib/state/runs";

/**
 * Held runs: the workflow runs a started engine dispatched or adopted, from
 * then until they settle. Each is followed to its end (its steps printed,
 * its posts routed, where it has got to recorded as progress) and written
 * back to its run file when it parks, resumes and settles, so the next
 * process can adopt a parked one.
 */

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

/** What is read of a held run while it is live. */
type HeldWorkflow = Pick<Dispatched<unknown>["workflow"], "root" | "state">;

interface HeldRun {
  /** Execution, publication, cleanup, and persistence, owned together. */
  finalized?: Promise<unknown>;
  /** Ownership of an adopted run's file; released once it settles or the process stops. */
  lock?: Lock;
  /**
   * Not yet written since it was dispatched. Persisting is not the run: a
   * failed write warns and the value still returns.
   */
  unsaved: boolean;
  /**
   * None of it depends on the run's output type, which the workflow's
   * private runtime holds invariantly.
   */
  readonly workflow: HeldWorkflow;
}

/** Give up a held run's file, once: another process may take it from here. */
function release(held: HeldRun): void {
  held.lock?.release();
  held.lock = undefined;
}

export interface HeldRunsOptions {
  /** Where each run's progress, parks and resumes go on its Execution Run. */
  readonly executions: Pick<Executions, "progress" | "resume" | "suspend">;
  readonly orchestrator: Orchestrator;
  readonly print: (line: string) => void;
  readonly router: FeedRouter;
  readonly scopes: RunScopes;
  /** Where run files go; without one, nothing is written. */
  readonly state: string | undefined;
  readonly store: InMemoryOrchestratorStore;
}

export class HeldRuns {
  readonly #options: HeldRunsOptions;
  readonly #held = new Map<string, HeldRun>();

  constructor(options: HeldRunsOptions) {
    this.#options = options;
    const { executions, orchestrator } = options;
    // A parked run is written as soon as it parks, so a crash or a quit while
    // it waits leaves a file the next process can adopt. It is written again
    // as soon as its answer is in, before the run goes on: a crash after that
    // finds a run that was mid-flight, which is skipped, not a stale question
    // that would be asked again over work already done.
    orchestrator.on("suspended", ({ runId }) => {
      if (this.#held.has(runId)) {
        this.save(runId);
        executions.suspend(runId);
      }
    });
    orchestrator.on("resumed", ({ runId }) => {
      if (this.#held.has(runId)) {
        this.save(runId);
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

  /** Write a run's file; a failed write warns. */
  save(runId: string, extras = this.#extrasOf(runId)): void {
    const { print, state, store } = this.#options;
    const held = this.#held.get(runId);
    if (state === undefined) {
      return;
    }
    try {
      saveRun(state, store.snapshot(), runId, extras);
      if (held) {
        held.unsaved = false;
      }
    } catch (error) {
      print(`[state] run ${runId} not saved: ${String(error)}`);
    }
  }

  /**
   * Hold a dispatched or adopted run until it ends, for the launcher to
   * settle. A run left parked when the process stops has not ended: its
   * record stays suspended.
   */
  follow(
    name: string,
    dispatched: Dispatched<unknown>,
    lock?: Lock
  ): DispatchedRun {
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
      result: this.#track(name, dispatched, lock),
    };
  }

  /** Follow a run to its end: print its steps, route its posts, write it back. */
  #track<O>(name: string, dispatched: Dispatched<O>, lock?: Lock): Promise<O> {
    const { executions, print, router, scopes, state } = this.#options;
    const held: HeldRun = {
      workflow: dispatched.workflow,
      ...(lock === undefined ? {} : { lock }),
      unsaved: true,
    };
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
        const extras = this.#extrasOf(dispatched.id);
        try {
          await scopes.settle(dispatched.id);
          this.save(dispatched.id, extras);
        } finally {
          this.#held.delete(dispatched.id);
          release(held);
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

  /**
   * At a stop, once the Orchestrator has drained: wait for every run that
   * ended to be finalized, then write each one not yet written.
   */
  async settle(): Promise<void> {
    await Promise.allSettled(
      [...this.#held.values()]
        .filter((held) => TERMINAL_RUN_STATUSES.has(held.workflow.state.status))
        .map((held) => held.finalized)
    );
    for (const [runId, held] of this.#held) {
      if (held.unsaved) {
        this.save(runId);
      }
    }
  }

  /** Give up every held run's file, as the process stops. */
  releaseAll(): void {
    for (const held of this.#held.values()) {
      release(held);
    }
  }

  #extrasOf(runId: string): RunExtras | undefined {
    const scope = this.#options.scopes.get(runId);
    return scope
      ? {
          ledger: scope.ledger.toJSON(),
          literals: Object.fromEntries(scope.literals),
          session: scope.session,
        }
      : undefined;
  }
}
