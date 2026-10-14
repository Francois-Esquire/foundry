import { assertSemverTag } from "@foundry/modules/manifest";
import { AsyncIteratorClass, EventPublisher } from "@orpc/server";
import type { WorksExecution } from "~/main/execution/contract";
import { WORKS_TASKS } from "~/shared/execution";
import {
  type ModuleBuildEvent,
  type ModuleSourceRevision,
  sameRevision,
} from "~/shared/modules";
import type { ModuleLibrary } from "../library";

export interface BuildRuntime {
  run(build: {
    moduleId: string;
    progress: (event: ModuleBuildEvent) => void;
    signal: AbortSignal;
    source: Record<string, string>;
  }): Promise<{
    source: Record<string, string>;
    outputs: Record<string, Uint8Array>;
  }>;
}

export class ModuleBuilds {
  readonly #active = new Map<
    string,
    { task: Promise<void>; signal: AbortSignal }
  >();
  readonly #shutdown = new AbortController();
  readonly #execution: Pick<WorksExecution, "dispatch">;
  readonly #library: ModuleLibrary;
  readonly #runtime: BuildRuntime;
  /** Each build is a `system` engine run; cancelling the build cancels the run. */
  constructor(options: {
    readonly execution: Pick<WorksExecution, "dispatch">;
    readonly library: ModuleLibrary;
    readonly runtime: BuildRuntime;
  }) {
    this.#execution = options.execution;
    this.#library = options.library;
    this.#runtime = options.runtime;
  }

  watch(
    id: string,
    tag: string,
    expected: ModuleSourceRevision,
    signal?: AbortSignal
  ): AsyncIteratorClass<ModuleBuildEvent, void> {
    assertSemverTag(tag);
    if (
      this.#shutdown.signal.aborted ||
      (this.#active.has(id) && !this.#active.get(id)?.signal.aborted)
    ) {
      throw new Error("A build is already running or Works is shutting down");
    }
    const cancel = new AbortController();
    const lifetime = AbortSignal.any([
      cancel.signal,
      this.#shutdown.signal,
      AbortSignal.timeout(600_000),
      ...(signal ? [signal] : []),
    ]);
    const publisher = new EventPublisher<{ progress: ModuleBuildEvent }>();
    const events = publisher.subscribe("progress");
    const progress = (event: ModuleBuildEvent) =>
      publisher.publish("progress", event);
    const previous = this.#active.get(id)?.task;
    const task = (async () => {
      await previous;
      await this.#execution.dispatch(
        WORKS_TASKS.build,
        { correlation: { moduleId: id }, signal: lifetime },
        (context) =>
          this.#run(
            id,
            tag,
            expected,
            context.run.id,
            context.signal,
            (event) => {
              progress(event);
              if (event.phase !== "complete" && event.phase !== "failed") {
                context.progress({ phase: event.phase });
              }
            }
          )
      );
    })()
      .catch((error: unknown) => {
        progress({
          message: lifetime.aborted
            ? "Build cancelled. Saved source is unchanged."
            : buildError(error),
          phase: "failed",
        });
      })
      .finally(() => {
        if (this.#active.get(id)?.task === task) {
          this.#active.delete(id);
        }
      });
    this.#active.set(id, { signal: lifetime, task });
    let done = false;
    return new AsyncIteratorClass<ModuleBuildEvent, void>(
      async () => {
        if (done) {
          return { done: true, value: undefined };
        }
        const result = await events.next();
        if (
          !result.done &&
          (result.value.phase === "complete" || result.value.phase === "failed")
        ) {
          done = true;
          await events.return();
        }
        return result;
      },
      async () => {
        cancel.abort();
        await task;
        await events.return();
      }
    );
  }

  async #run(
    id: string,
    tag: string,
    expected: ModuleSourceRevision,
    runId: string,
    signal: AbortSignal,
    progress: (event: ModuleBuildEvent) => void
  ) {
    progress({ phase: "preparing" });
    signal.throwIfAborted();
    const details = await this.#library.details(id);
    if (!(details?.binding && sameRevision(details.binding, expected))) {
      throw new Error(
        "Module source changed. Reload the saved source before building."
      );
    }
    if (details.releases.some((release) => release.tag === tag)) {
      throw new Error(
        "This release version already exists. Choose a new version."
      );
    }
    const built = await this.#runtime.run({
      moduleId: id,
      progress,
      signal,
      source: details.source,
    });
    signal.throwIfAborted();
    progress({ phase: "publishing" });
    // The publish run names this build run as its parent.
    const { version, binding } = await this.#library.publish(id, expected, {
      ...built,
      builtBy: runId,
      tag,
    });
    progress({
      binding,
      phase: "complete",
      release: {
        contentId: version.contentId,
        tag: version.tag,
        views: Object.entries(version.manifest.views).map(([viewId, view]) => ({
          id: viewId,
          ...view,
        })),
      },
    });
  }

  async shutdown() {
    this.#shutdown.abort();
    await Promise.all([...this.#active.values()].map((entry) => entry.task));
  }
}

function buildError(error: unknown) {
  return error instanceof Error ? error.message : "Module build failed";
}
