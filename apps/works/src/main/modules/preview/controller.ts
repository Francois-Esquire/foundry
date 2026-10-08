import { randomUUID } from "node:crypto";
import type { ModuleVersion } from "@foundry/modules/domain";
import { AsyncIteratorClass } from "@orpc/server";
import type { ModulePreview } from "~/shared/modules";
import type { ModuleLibrary } from "../library";

export class ModulePreviewError extends Error {
  override readonly name = "ModulePreviewError";
}

export interface PreviewRuntime {
  shutdown(): Promise<void>;
  start(
    version: ModuleVersion,
    signal: AbortSignal
  ): Promise<{
    origin: string;
    close(): Promise<void>;
  }>;
}

export class ModulePreviews {
  readonly #active = new Map<
    string,
    { origin: string; views: ModulePreview["views"] }
  >();

  readonly #shutdown = new AbortController();
  readonly #watches = new Set<AsyncIteratorClass<ModulePreview, void>>();
  readonly #library: ModuleLibrary;
  readonly #runtime: PreviewRuntime;

  constructor(library: ModuleLibrary, runtime: PreviewRuntime) {
    this.#library = library;
    this.#runtime = runtime;
  }

  watch(
    id: string,
    contentId: string,
    signal?: AbortSignal
  ): AsyncIteratorClass<ModulePreview, void> {
    if (this.#shutdown.signal.aborted) {
      throw new ModulePreviewError("Module previews are shutting down");
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
    const iterator = this.#watch(id, contentId, controller.signal);
    const watch = new AsyncIteratorClass<ModulePreview, void>(
      () => iterator.next(),
      async () => {
        abort();
        this.#watches.delete(watch);
        signal?.removeEventListener("abort", abort);
        await iterator.return(undefined);
      }
    );
    this.#watches.add(watch);
    return watch;
  }

  async *#watch(
    id: string,
    contentId: string,
    signal: AbortSignal
  ): AsyncGenerator<ModulePreview, void> {
    const version = await this.#library.release(id, contentId);
    if (!version) {
      throw new ModulePreviewError("Module release not found");
    }
    const views = Object.entries(version.manifest.views).map(
      ([viewId, view]) => ({ id: viewId, ...view })
    );
    if (views.length === 0) {
      throw new ModulePreviewError("This release has no views");
    }
    signal.throwIfAborted();
    const handle = await this.#runtime.start(version, signal);
    const token = randomUUID();
    try {
      signal.throwIfAborted();
      this.#active.set(token, { origin: handle.origin, views });
      yield { origin: `module-preview://${token}`, views };
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    } finally {
      this.#active.delete(token);
      await handle.close();
    }
  }

  endpoint(token: string) {
    return this.#active.get(token);
  }

  async shutdown(): Promise<void> {
    this.#shutdown.abort();
    this.#active.clear();
    const results = await Promise.allSettled(
      [...this.#watches].map((watch) => watch.return())
    );
    await this.#runtime.shutdown();
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length) {
      throw new AggregateError(failures, "Module preview cleanup failed");
    }
  }
}
