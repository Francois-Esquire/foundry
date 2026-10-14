import { randomUUID } from "node:crypto";
import type { InstallationId, ModuleVersion } from "@foundry/modules/domain";
import { AsyncIteratorClass } from "@orpc/server";
import type { WorksExecution } from "~/main/execution/contract";
import { Changing, latest } from "~/main/platform/latest";
import { WORKS_TASKS } from "~/shared/execution";
import type { ModuleSession } from "~/shared/modules";
import type { ModuleLibrary } from "../library";
import type { ProgramCalls } from "./program-calls";

export class ModuleRuntimeError extends Error {
  override readonly name = "ModuleRuntimeError";
}

export interface ModuleRuntime {
  /** A Grant was revoked: cancel the Installation's active Invocations under it. */
  revoked(input: {
    readonly installationId: InstallationId;
    readonly capability: string;
  }): void;
  shutdown(): Promise<void>;
  start(
    version: ModuleVersion,
    signal: AbortSignal
  ): Promise<{
    origin: string;
    close(): Promise<void>;
  }>;
}

/** Where the `module-app://` host of an open app's Program is served from. */
export interface ModuleEndpoint {
  readonly origin: string;
  /** Aborts when the Program stops serving, ending its streamed responses. */
  readonly signal: AbortSignal;
  readonly views: ModuleSession["views"];
}

/** One Program lifetime of an open app: a `system` run from start to stop. */
interface ProgramLifetime {
  /**
   * Resolves once the Program is up, with the `module-app://` host serving
   * it; rejects when it fails to start.
   */
  readonly origin: Promise<string>;
  /** Settles once the Program has stopped; rejects when it fails to start or stop. */
  readonly settled: Promise<void>;
  /** Ends a Program that is up. */
  stop(): void;
}

/** What an open app's watcher is shown; only the latest matters. */
type AppState =
  | { readonly kind: "starting" }
  | { readonly kind: "up" | "restarting"; readonly origin: string }
  | { readonly error: unknown; readonly kind: "failed" };

/** An open app and the Program lifetime currently serving it. */
interface OpenApp {
  /** Set once the app closes: its Programs stopped, or how they failed to. */
  closed?: Promise<void>;
  /** Ends the app: its watch, and the Program it shows. */
  readonly controller: AbortController;
  readonly moduleId: string;
  /** Unset while the app opens: no Program has started yet. */
  program?: {
    /** Starts the next Program lifetime, which reports to `state`. */
    readonly launch: () => ProgramLifetime;
    lifetime: ProgramLifetime;
  };
  /** Restarts run one at a time per app. */
  restarts: Promise<unknown>;
  /** Aborted when the app ends, whether closed here or by its watcher. */
  readonly signal: AbortSignal;
  readonly state: Changing<AppState>;
}

export interface ModuleSessionsOptions {
  /** Refuses a Module that may not start now, such as one turned off. */
  readonly admit?: (moduleId: string) => Promise<void>;
  /** Where each Program's Gateway invocations are recorded on its run. */
  readonly calls?: Pick<ProgramCalls, "attach">;
  /** Each Program lifetime is a `system` engine run, from its start to its stop. */
  readonly execution: Pick<WorksExecution, "dispatch">;
  readonly library: Pick<ModuleLibrary, "release">;
  readonly runtime: ModuleRuntime;
}

export class ModuleSessions {
  readonly #active = new Map<string, ModuleEndpoint>();
  /**
   * Each open app from the moment its watch starts, before anything is
   * awaited, so a stop while it is still opening ends it before its Program
   * starts.
   */
  readonly #apps = new Set<OpenApp>();
  readonly #shutdown = new AbortController();
  readonly #admit: (moduleId: string) => Promise<void>;
  readonly #calls: Pick<ProgramCalls, "attach"> | undefined;
  readonly #execution: Pick<WorksExecution, "dispatch">;
  readonly #library: Pick<ModuleLibrary, "release">;
  readonly #runtime: ModuleRuntime;

  constructor(options: ModuleSessionsOptions) {
    this.#admit = options.admit ?? (() => Promise.resolve());
    this.#calls = options.calls;
    this.#execution = options.execution;
    this.#library = options.library;
    this.#runtime = options.runtime;
  }

  /**
   * Open an app: its Program's endpoint once it is up, a `restarting`
   * marker while a restart replaces it (a watcher that was not waiting
   * skips straight to the new endpoint), and the error if a start fails.
   * Ends when `signal` aborts, the Module stops, or Works shuts down.
   */
  watch(
    id: string,
    contentId: string,
    signal?: AbortSignal
  ): AsyncIteratorClass<ModuleSession, void> {
    if (this.#shutdown.signal.aborted) {
      throw new ModuleRuntimeError("Module runtime is shutting down");
    }
    // Returning ends the watch at once, even while it waits for a change.
    const closed = new AbortController();
    const iterator = this.#watch(
      id,
      contentId,
      AbortSignal.any([closed.signal, ...(signal ? [signal] : [])])
    );
    return new AsyncIteratorClass<ModuleSession, void>(
      () => iterator.next(),
      async () => {
        closed.abort();
        await iterator.return(undefined);
      }
    );
  }

  async *#watch(
    id: string,
    contentId: string,
    watcher: AbortSignal
  ): AsyncGenerator<ModuleSession, void> {
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      this.#shutdown.signal,
      watcher,
    ]);
    const state = new Changing<AppState>({ kind: "starting" });
    const app: OpenApp = {
      controller,
      moduleId: id,
      restarts: Promise.resolve(),
      signal,
      state,
    };
    this.#apps.add(app);
    try {
      await this.#admit(id);
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
      const launch = () =>
        this.#launch({ contentId, id, signal, state, version, views });
      app.program = { launch, lifetime: launch() };
      for await (const current of latest({
        read: () => state.value,
        signal,
        subscribe: (changed) => state.subscribe(changed),
      })) {
        if (current.kind === "failed") {
          throw current.error;
        }
        if (current.kind !== "starting") {
          yield {
            origin: current.origin,
            ...(current.kind === "restarting" ? { restarting: true } : {}),
            views,
          };
        }
      }
    } finally {
      await this.#close(app);
    }
  }

  /**
   * Ends the app once; every caller waits for the same stop. A restart in
   * flight finishes first, then the Program shown last stops.
   */
  #close(app: OpenApp): Promise<void> {
    app.closed ??= (async () => {
      app.controller.abort();
      try {
        await app.restarts.catch(() => undefined);
        app.program?.lifetime.stop();
        await app.program?.lifetime.settled;
      } finally {
        this.#apps.delete(app);
      }
    })();
    return app.closed;
  }

  /**
   * One Program lifetime as a `system` run. A stop before the Program is up
   * cancels its run; a stop after that ends it complete. A crash leaves it
   * running for the next start to mark interrupted.
   */
  #launch(app: {
    readonly contentId: string;
    readonly id: string;
    readonly signal: AbortSignal;
    readonly state: Changing<AppState>;
    readonly version: ModuleVersion;
    readonly views: ModuleSession["views"];
  }): ProgramLifetime {
    const { contentId, id, signal, version, views } = app;
    const cancel = new AbortController();
    const stop = new AbortController();
    let running = false;
    const stopStart = () => {
      if (!running) {
        cancel.abort(signal.reason);
      }
    };
    signal.addEventListener("abort", stopStart, { once: true });
    if (signal.aborted) {
      cancel.abort(signal.reason);
    }
    const started = Promise.withResolvers<string>();
    const lifetime: ProgramLifetime = {
      origin: started.promise,
      settled: this.#execution.dispatch(
        WORKS_TASKS.program,
        {
          correlation: { contentId, moduleId: id },
          signal: cancel.signal,
        },
        async (context) => {
          const handle = await this.#runtime.start(version, context.signal);
          running = true;
          const detach = this.#calls?.attach(id, context);
          signal.removeEventListener("abort", stopStart);
          const token = randomUUID();
          const serving = new AbortController();
          try {
            // Its start is ordered on the queue; its lifetime holds no slot.
            context.release();
            this.#active.set(token, {
              origin: handle.origin,
              signal: serving.signal,
              views,
            });
            started.resolve(token);
            await aborted(
              AbortSignal.any([signal, context.signal, stop.signal])
            );
          } finally {
            // Unreachable first, and no proxied response outlives the Program.
            this.#active.delete(token);
            serving.abort();
            try {
              await handle.close();
            } finally {
              detach?.();
            }
          }
        }
      ),
      stop: () => stop.abort(),
    };
    lifetime.settled.catch((error: unknown) => started.reject(error));
    started.promise.then(
      (token) => app.state.set({ kind: "up", origin: `module-app://${token}` }),
      (error: unknown) => app.state.set({ error, kind: "failed" })
    );
    return lifetime;
  }

  /**
   * Stop and start every open app of the Module again, so each Program runs
   * under the authority its Installation holds now (network policy is fixed
   * when a Program starts). Resolves once every previous Program has stopped
   * and its replacement is up or has failed to start; rejects when a
   * previous Program did not stop, as its authority may still be live.
   * Returns how many Programs were replaced.
   */
  async restart(moduleId: string): Promise<number> {
    const apps = [...this.#apps].filter((app) => app.moduleId === moduleId);
    const replaced = await Promise.all(
      apps.map((app) => {
        const next = app.restarts.then(() => this.#replace(app));
        app.restarts = next.catch(() => undefined);
        return next;
      })
    );
    return replaced.filter(Boolean).length;
  }

  async #replace(app: OpenApp): Promise<boolean> {
    const { program } = app;
    // An app still opening starts its Program under the authority held then.
    if (!program || app.signal.aborted) {
      return false;
    }
    const previous = program.lifetime;
    // A start already under way read the old authority: let it come up,
    // then replace it.
    let token: string;
    try {
      token = await previous.origin;
    } catch {
      // It never ran.
      return false;
    }
    app.state.set({ kind: "restarting", origin: `module-app://${token}` });
    previous.stop();
    await previous.settled;
    if (app.signal.aborted) {
      return true;
    }
    program.lifetime = program.launch();
    await program.lifetime.origin.catch(() => undefined);
    return true;
  }

  /** Module off: close the Module's open apps, waiting for their Programs to stop. */
  async stop(moduleId: string): Promise<void> {
    const failures = await closeAll(
      [...this.#apps].filter((app) => app.moduleId === moduleId),
      (app) => this.#close(app)
    );
    if (failures.length) {
      throw new AggregateError(failures, "The Module's app did not stop");
    }
  }

  endpoint(token: string): ModuleEndpoint | undefined {
    return this.#active.get(token);
  }

  async shutdown(): Promise<void> {
    this.#shutdown.abort();
    this.#active.clear();
    const failures = await closeAll([...this.#apps], (app) => this.#close(app));
    await this.#runtime.shutdown();
    if (failures.length) {
      throw new AggregateError(failures, "Module runtime cleanup failed");
    }
  }
}

/** Closes every app, collecting the failures. */
async function closeAll(
  apps: readonly OpenApp[],
  close: (app: OpenApp) => Promise<void>
): Promise<unknown[]> {
  const results = await Promise.allSettled(apps.map(close));
  return results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
