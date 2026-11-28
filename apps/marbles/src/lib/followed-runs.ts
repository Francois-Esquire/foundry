import type { WorkflowResult } from "@foundry/workflows/workflow";
import { ambient, type ContextSnapshot } from "~/lib/async-context";
import type { Executions } from "~/lib/executions";
import type { FeedRouter } from "~/lib/feed/route";
import type { DispatchedRun } from "~/lib/launcher";
import { observeSteps } from "~/lib/observe";
import type { OwnerLiveness } from "~/lib/owner-liveness";
import type { AttachedWorkflow, RunQueue } from "~/lib/run-queue";
import type { RunScopes } from "~/lib/run-scope";
import { RunOutput, type RunOutputSink } from "~/lib/state/output";

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

interface Observation {
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

interface Opened {
  readonly output: RunOutput;
  readonly routed: ReturnType<FeedRouter["observe"]>;
}

interface Followed {
  readonly context: ContextSnapshot;
  ended?: WorkflowResult<unknown>;
  finalized?: Promise<unknown>;
  idle: boolean;
  last?: AttachedWorkflow;
  readonly name: string;
  observationFailure?: { readonly reason: unknown };
  readonly observing: Set<Observation>;
  opened?: Opened;
  readonly runId: string;
}

export interface TrackedRun {
  drop(): void;
  start(): DispatchedRun;
}

export interface FollowedRunsOptions {
  readonly executions: Pick<Executions, "progress">;
  readonly liveness?: OwnerLiveness;
  readonly outputSink?: RunOutputSink;
  readonly print: (line: string) => void;
  readonly queue: RunQueue;
  readonly router: FeedRouter;
  readonly scopes: RunScopes;
  readonly state: string | undefined;
}

export class FollowedRuns {
  readonly #options: FollowedRunsOptions;
  readonly #followed = new Map<string, Followed>();

  constructor(options: FollowedRunsOptions) {
    this.#options = options;
    options.queue.on("suspended", (runId) => {
      const followed = this.#followed.get(runId);
      if (followed !== undefined) {
        followed.idle = true;
        followed.last = undefined;
      }
    });
  }

  has(runId: string): boolean {
    return this.#followed.has(runId);
  }

  ids(): readonly string[] {
    return [...this.#followed.keys()];
  }

  workflow(runId: string): AttachedWorkflow | undefined {
    return this.#options.queue.attached(runId);
  }

  track(name: string, runId: string): TrackedRun {
    if (this.#followed.has(runId)) {
      throw new Error(`Run ${runId} already exists`);
    }
    const followed: Followed = {
      context: ambient.snapshot(),
      idle: false,
      name,
      observing: new Set(),
      runId,
    };
    this.#followed.set(runId, followed);
    const attached = this.#options.queue.attached(runId);
    if (attached !== undefined) {
      this.attach(runId, attached);
    }
    return {
      drop: () => {
        this.#stopObserving(followed);
        if (this.#followed.get(runId) === followed) {
          this.#followed.delete(runId);
        }
      },
      start: () => this.#start(followed),
    };
  }

  attach(runId: string, workflow: AttachedWorkflow): void {
    const followed = this.#followed.get(runId);
    if (followed === undefined) {
      return;
    }
    this.#stopObserving(followed);
    followed.idle = false;
    followed.last = workflow;
    const controller = new AbortController();
    const done = followed.context(() =>
      this.#observe(followed, workflow, controller.signal)
    );
    const observation = { controller, done };
    followed.observing.add(observation);
    done.then(
      () => followed.observing.delete(observation),
      (reason: unknown) => {
        followed.observing.delete(observation);
        followed.observationFailure ??= { reason };
      }
    );
  }

  #observe(
    followed: Followed,
    workflow: AttachedWorkflow,
    signal: AbortSignal
  ): Promise<void> {
    const { executions, print } = this.#options;
    const { output, routed } = this.#opened(followed);
    const { name, runId } = followed;
    return observeSteps(name, workflow, {
      onEvent: (event) => {
        routed.onEvent(event);
        if (STEP_LIFECYCLE.has(event._tag)) {
          executions.progress(runId, {
            event: event._tag,
            step: [name, ...event.path.slice(1)].join("."),
          });
        }
      },
      print,
      signal,
      write: (text, chunk) => output.text(text, chunk),
    });
  }

  async settle(): Promise<void> {
    const { queue } = this.#options;
    const followed = [...this.#followed.values()];
    const settled = await Promise.all(
      followed.map((each) => queue.hasSettled(each.runId).catch(() => false))
    );
    await Promise.allSettled(
      followed
        .filter((_, index) => settled[index])
        .map((each) => each.finalized)
    );
    await Promise.allSettled(
      followed.map((each) => each.opened?.routed.settled())
    );
  }

  #opened(followed: Followed): Opened {
    if (followed.opened === undefined) {
      const { liveness, outputSink, print, router, state } = this.#options;
      followed.opened = {
        output: new RunOutput(state, followed.runId, followed.name, print, {
          ...(liveness === undefined ? {} : { liveness }),
          ...(outputSink === undefined ? {} : { sink: outputSink }),
        }),
        routed: router.observe(followed.name, followed.runId),
      };
    }
    return followed.opened;
  }

  #stopObserving(followed: Followed, reason?: unknown): void {
    for (const { controller } of followed.observing) {
      controller.abort(reason);
    }
  }

  #start(followed: Followed): DispatchedRun {
    const { output } = this.#opened(followed);
    const result = output.follow(
      this.#complete(followed),
      () => followed.ended?.status === "cancelled"
    );
    followed.finalized = result;
    result.catch(() => undefined);
    return { result };
  }

  async #complete(followed: Followed): Promise<unknown> {
    const { queue, router, scopes } = this.#options;
    const { name, runId } = followed;
    const { routed } = this.#opened(followed);
    try {
      let settled: WorkflowResult<unknown>;
      try {
        settled = await queue.settled(runId);
      } catch (error) {
        this.#stopObserving(followed, error);
        throw error;
      }
      followed.ended = settled;
      if (followed.idle) {
        this.#stopObserving(followed);
      }
      await Promise.allSettled([...followed.observing].map(({ done }) => done));
      await routed.settled();
      if (settled.status !== "complete") {
        const message =
          settled.status === "failed"
            ? `run "${name}" failed: ${settled.error.message}`
            : `run "${name}" was cancelled: ${settled.reason ?? router.cancelReason(runId) ?? "no reason"}`;
        await router.close(runId);
        throw new RunEndedError(message);
      }
      if (followed.observationFailure !== undefined) {
        throw followed.observationFailure.reason;
      }
      return await this.#valueOf(followed, settled.value);
    } finally {
      try {
        await scopes.settle(runId);
      } finally {
        if (this.#followed.get(runId) === followed) {
          this.#followed.delete(runId);
        }
      }
    }
  }

  async #valueOf(followed: Followed, stored: unknown): Promise<unknown> {
    const { idle, last } = followed;
    if (idle || last?.state.status !== "complete") {
      return stored;
    }
    const local = await last.result();
    return local.status === "complete" ? local.value : stored;
  }
}
