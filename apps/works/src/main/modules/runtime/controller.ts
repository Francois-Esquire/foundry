import { randomUUID } from "node:crypto";
import type { ModuleVersion } from "@foundry/modules/domain";
import { AsyncIteratorClass } from "@orpc/server";
import type { ModuleSession } from "~/shared/modules";
import type { ModuleLibrary } from "../library";

export class ModuleRuntimeError extends Error {
  override readonly name = "ModuleRuntimeError";
}

export interface ModuleRuntime {
  shutdown(): Promise<void>;
  start(
    version: ModuleVersion,
    signal: AbortSignal
  ): Promise<{
    origin: string;
    close(): Promise<void>;
  }>;
}

export class ModuleSessions {
  readonly #active = new Map<
    string,
    { origin: string; views: ModuleSession["views"] }
  >();

  readonly #shutdown = new AbortController();
  readonly #watches = new Set<AsyncIteratorClass<ModuleSession, void>>();
  readonly #library: ModuleLibrary;
  readonly #runtime: ModuleRuntime;

  constructor(library: ModuleLibrary, runtime: ModuleRuntime) {
    this.#library = library;
    this.#runtime = runtime;
  }

  watch(
    id: string,
    contentId: string,
    signal?: AbortSignal
  ): AsyncIteratorClass<ModuleSession, void> {
    if (this.#shutdown.signal.aborted) {
      throw new ModuleRuntimeError("Module runtime is shutting down");
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
    const iterator = this.#watch(id, contentId, controller.signal);
    const watch = new AsyncIteratorClass<ModuleSession, void>(
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
  ): AsyncGenerator<ModuleSession, void> {
    const version = await this.#library.release(id, contentId);
    if (!version) {
      throw new ModuleRuntimeError("Module release not found");
    }
    const views = Object.entries(version.manifest.views).map(
      ([viewId, view]) => ({ id: viewId, ...view })
    );
    if (views.length === 0) {
      throw new ModuleRuntimeError("This release has no views");
    }
    signal.throwIfAborted();
    const handle = await this.#runtime.start(version, signal);
    const token = randomUUID();
    try {
      signal.throwIfAborted();
      this.#active.set(token, { origin: handle.origin, views });
      yield { origin: `module-app://${token}`, views };
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
      throw new AggregateError(failures, "Module runtime cleanup failed");
    }
  }
}
