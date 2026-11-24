import type { WorkflowResult } from "@foundry/workflows/workflow";
import type { Executions } from "~/lib/executions";
import type { FeedRouter } from "~/lib/feed/route";
import type { DispatchedRun } from "~/lib/launcher";
import { observeSteps } from "~/lib/observe";
import type { RunScopes } from "~/lib/run-scope";
import { RunOutput } from "~/lib/state/output";
import type { HeldWorkflow, WorkflowQueue } from "~/lib/workflow-queue";

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
  ended?: WorkflowResult<unknown>;
  finalized?: Promise<unknown>;
  idle: boolean;
  last?: HeldWorkflow;
  readonly name: string;
  readonly observations: Observation[];
  opened?: Opened;
  readonly runId: string;
}

export interface TrackedRun {
  drop(): void;
  start(): DispatchedRun;
}

export interface HeldRunsOptions {
  readonly executions: Pick<
    Executions,
    "get" | "progress" | "resume" | "suspend"
  >;
  readonly print: (line: string) => void;
  readonly queue: WorkflowQueue;
  readonly router: FeedRouter;
  readonly scopes: RunScopes;
  readonly state: string | undefined;
}

export class HeldRuns {
  readonly #options: HeldRunsOptions;
  readonly #followed = new Map<string, Followed>();

  constructor(options: HeldRunsOptions) {
    this.#options = options;
    const { executions, queue } = options;
    queue.on("suspended", (runId) => {
      const followed = this.#followed.get(runId);
      if (followed !== undefined) {
        followed.idle = true;
        executions.suspend(runId);
      }
    });
  }

  has(runId: string): boolean {
    return this.#followed.has(runId);
  }

  ids(): readonly string[] {
    return [...this.#followed.keys()];
  }

  workflow(runId: string): HeldWorkflow | undefined {
    return this.#options.queue.attached(runId);
  }

  track(name: string, runId: string): TrackedRun {
    if (this.#followed.has(runId)) {
      throw new Error(`Run ${runId} already exists`);
    }
    const followed: Followed = { idle: false, name, observations: [], runId };
    this.#followed.set(runId, followed);
    const attached = this.#options.queue.attached(runId);
    if (attached !== undefined) {
      this.attempt(runId, attached);
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

  attempt(runId: string, workflow: HeldWorkflow): void {
    const followed = this.#followed.get(runId);
    if (followed === undefined) {
      return;
    }
    this.#stopObserving(followed);
    followed.idle = false;
    followed.last = workflow;
    const { executions, print } = this.#options;
    if (executions.get(runId)?.status === "suspended") {
      executions.resume(runId);
    }
    const { output, routed } = this.#opened(followed);
    const { name } = followed;
    const controller = new AbortController();
    const done = observeSteps(name, workflow, {
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
      signal: controller.signal,
      write: (text, chunk) => output.text(text, chunk),
    });
    done.catch(() => undefined);
    followed.observations.push({ controller, done });
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
      const { print, router, state } = this.#options;
      followed.opened = {
        output: new RunOutput(state, followed.runId, followed.name, print),
        routed: router.observe(followed.name, followed.runId),
      };
    }
    return followed.opened;
  }

  #stopObserving(followed: Followed, reason?: unknown): void {
    for (const { controller } of followed.observations) {
      controller.abort(reason);
    }
  }

  #start(followed: Followed): DispatchedRun {
    const { queue } = this.#options;
    const { output } = this.#opened(followed);
    const result = output.follow(
      this.#complete(followed),
      () => followed.ended?.status === "cancelled"
    );
    followed.finalized = result;
    result.catch(() => undefined);
    return {
      cancel: async () => {
        await queue.cancelRun(followed.runId);
      },
      endedAs: () => {
        const status = followed.ended?.status;
        if (status === "cancelled") {
          return "cancelled";
        }
        return status === undefined ? undefined : "failed";
      },
      result,
    };
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
      const observations = await Promise.allSettled(
        followed.observations.map(({ done }) => done)
      );
      await routed.settled();
      if (settled.status !== "complete") {
        const message =
          settled.status === "failed"
            ? `run "${name}" failed: ${settled.error.message}`
            : `run "${name}" was cancelled: ${settled.reason ?? router.cancelReason(runId) ?? "no reason"}`;
        await router.close(runId);
        throw new RunEndedError(message);
      }
      const failed = observations.find(
        (observation): observation is PromiseRejectedResult =>
          observation.status === "rejected"
      );
      if (failed !== undefined) {
        throw failed.reason;
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
