import { assertSemverTag } from "@foundry/modules/manifest";
import { AsyncIteratorClass, EventPublisher } from "@orpc/server";
import type { ModuleBuildEvent, ModuleSourceRevision } from "~/shared/modules";
import type { ModuleLibrary } from "../library";

export interface BuildRuntime {
  run(
    source: Record<string, string>,
    signal: AbortSignal,
    progress: (event: ModuleBuildEvent) => void
  ): Promise<{
    source: Record<string, string>;
    outputs: Record<string, Uint8Array>;
  }>;
  shutdown(): Promise<void>;
}

export class ModuleBuilds {
  readonly #active = new Map<
    string,
    { task: Promise<void>; signal: AbortSignal }
  >();
  readonly #shutdown = new AbortController();
  readonly #library: ModuleLibrary;
  readonly #runtime: BuildRuntime;
  constructor(library: ModuleLibrary, runtime: BuildRuntime) {
    this.#library = library;
    this.#runtime = runtime;
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
      await this.#run(id, tag, expected, lifetime, progress);
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
    signal: AbortSignal,
    progress: (event: ModuleBuildEvent) => void
  ) {
    progress({ phase: "preparing" });
    signal.throwIfAborted();
    const details = await this.#library.details(id);
    if (
      !details?.binding ||
      details.binding.artifactId !== expected.artifactId ||
      details.binding.contentId !== expected.contentId ||
      details.binding.updatedAt !== expected.updatedAt
    ) {
      throw new Error(
        "Module source changed. Reload the saved source before building."
      );
    }
    if (details.releases.some((release) => release.tag === tag)) {
      throw new Error(
        "This release version already exists. Choose a new version."
      );
    }
    const built = await this.#runtime.run(details.source, signal, progress);
    signal.throwIfAborted();
    progress({ phase: "publishing" });
    const { version, binding } = await this.#library.publish(id, expected, {
      ...built,
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
    await this.#runtime.shutdown();
  }
}

function buildError(error: unknown) {
  return error instanceof Error ? error.message : "Module build failed";
}
