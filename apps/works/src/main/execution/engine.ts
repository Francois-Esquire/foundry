import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ArtifactManager,
  blobFiles,
  Engine,
  type ExecutionRuns,
  InMemoryArtifactStore,
  InMemorySessionStore,
  JsonArtifactStore,
  JsonSessionStore,
  ModelManager,
  type StateStore,
} from "@foundry.sh/marbles/engine";
import { WORKS_TASKS } from "~/shared/execution";
import {
  type DispatchOptions,
  MODULE_QUEUE_DEFAULTS,
  type ModuleQueue,
  type ModuleQueueKind,
  moduleQueue,
  type RunBody,
  SYSTEM_QUEUE,
  type WorksExecution,
} from "./contract";
import type { WorkflowRegistry } from "./workflows";

export class WorksEngineStartError extends Error {
  override readonly name = "WorksEngineStartError";
}

/**
 * The outcome of a run an earlier Works process queued and never started:
 * its body lived in that process, so nothing ran and nothing changed.
 */
class AbandonedRequestError extends Error {
  override readonly name = "AbandonedRequest";
  constructor() {
    super("Works quit before this request started, so nothing was changed");
  }
}

export interface WorksEngineOptions {
  /** Works-owned engine directory, outside product storage. Omit to keep runs in memory. */
  readonly directory?: string;
  /** The providers agent sessions route to; an empty manager when omitted. */
  readonly models?: ModelManager;
  readonly print?: (line: string) => void;
  /** Replaces the engine's state store; tests use it to fail a start. */
  readonly store?: StateStore;
  /**
   * The workflows Modules may start, registered with Works' own tasks
   * before recovery, so a run an exited process left queued under one of
   * them is let in again and settles.
   */
  readonly workflows?: Pick<WorkflowRegistry, "identities">;
}

/**
 * The run's request: which body to call. Bodies stay in memory, so source
 * text and package bytes never enter the run store.
 */
interface RunRequest {
  readonly request: string;
}

/**
 * Start Marbles as Works' required engine, recovering its run store first.
 * Works accepts no save, settings change or launch before this resolves;
 * a failure here fails Works startup.
 *
 * Recovery: a run that was running when its process died is recorded
 * `interrupted`; nothing replays it. A run that was still queued is let in
 * again, in its original order and before any new launch, and fails at once
 * with {@link AbandonedRequestError}: its body (source text, package bytes,
 * a prompt) was never persisted, so there is nothing safe to run, and the
 * record says so rather than staying queued forever.
 */
export async function startWorksEngine(
  options: WorksEngineOptions = {}
): Promise<WorksExecution> {
  const { directory } = options;
  const print = options.print ?? (() => undefined);
  try {
    if (directory !== undefined) {
      await mkdir(directory, { mode: 0o700, recursive: true });
    }
    const engine = new Engine({
      artifacts:
        directory === undefined
          ? new ArtifactManager({ store: new InMemoryArtifactStore() })
          : new ArtifactManager({
              files: blobFiles(path.join(directory, "feed", "blobs")),
              store: new JsonArtifactStore({
                path: path.join(directory, "feed", "records.json"),
              }),
            }),
      // Module sandboxes belong to the Works coordinator; agent work borrows
      // them there rather than opening VMs the machine ceilings cannot see.
      containers: () =>
        Promise.reject(
          new Error("Borrow Module sandboxes from the Works coordinator")
        ),
      models: options.models ?? new ModelManager(),
      print,
      queues: { [SYSTEM_QUEUE]: { concurrency: Number.POSITIVE_INFINITY } },
      recoverQueued: true,
      root: directory ?? tmpdir(),
      sessions:
        directory === undefined
          ? new InMemorySessionStore()
          : new JsonSessionStore(path.join(directory, "sessions"), {
              warn: print,
            }),
      ...(directory === undefined
        ? {}
        : { state: path.join(directory, "state") }),
      ...(options.store === undefined ? {} : { store: options.store }),
      workspaceId: "foundry-works",
    });
    const execution = new EngineExecution(
      engine,
      options.workflows?.identities() ?? []
    );
    try {
      await engine.start();
    } catch (error) {
      await engine.dispose().catch(() => undefined);
      throw error;
    }
    return execution;
  } catch (error) {
    throw new WorksEngineStartError(
      `The execution engine could not start: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

class EngineExecution implements WorksExecution {
  readonly #bodies = new Map<string, RunBody<unknown>>();
  readonly #engine: Engine;
  readonly #tasks = new Set<string>();
  readonly runs: ExecutionRuns;

  constructor(engine: Engine, tasks: readonly string[]) {
    this.#engine = engine;
    this.runs = engine.executions;
    for (const name of [...Object.values(WORKS_TASKS), ...tasks]) {
      this.#task(name);
    }
  }

  #task(name: string) {
    if (this.#tasks.has(name)) {
      return;
    }
    this.#tasks.add(name);
    // A record left queued by an older process may carry no input.
    this.#engine.task<RunRequest | undefined, unknown>({
      name,
      queue: SYSTEM_QUEUE,
      run: async (input, context) => {
        const body =
          input?.request === undefined
            ? undefined
            : this.#bodies.get(input.request);
        if (!body) {
          // Only a run another process left queued can get here.
          throw new AbandonedRequestError();
        }
        return await body(context);
      },
    });
  }

  cancel(id: string) {
    return this.#engine.cancel(id);
  }

  configureModuleQueues(
    moduleId: string,
    settings: Partial<Record<ModuleQueueKind, number>>
  ) {
    for (const [kind, concurrency] of Object.entries(settings)) {
      if (concurrency !== undefined) {
        this.runs.configure(moduleQueue(moduleId, kind as ModuleQueueKind), {
          concurrency,
        });
      }
    }
  }

  async dispatch<O>(name: string, options: DispatchOptions, body: RunBody<O>) {
    const { result } = await this.launch(name, options, body);
    return await result;
  }

  async launch<O>(name: string, options: DispatchOptions, body: RunBody<O>) {
    const { signal } = options;
    signal?.throwIfAborted();
    this.#task(name);
    const queue =
      options.queue === undefined
        ? SYSTEM_QUEUE
        : this.#moduleQueue(options.queue);
    const request = randomUUID();
    this.#bodies.set(request, body as RunBody<unknown>);
    const { correlation } = options;
    let launched: Awaited<ReturnType<Engine["launch"]>>;
    try {
      launched = await this.#engine.launch<O>(
        name,
        { request } satisfies RunRequest,
        {
          ...(correlation === undefined ? {} : { correlation }),
          queue,
          ...(options.recordErrorMessage === undefined
            ? {}
            : { recordErrorMessage: options.recordErrorMessage }),
        }
      );
    } catch (error) {
      this.#bodies.delete(request);
      throw error;
    }
    const { id } = launched;
    const cancel = () => {
      this.#engine.cancel(id).catch(() => undefined);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) {
      cancel();
    }
    const result = (launched.result as Promise<O>).finally(() => {
      this.#bodies.delete(request);
      signal?.removeEventListener("abort", cancel);
    });
    return { id, result };
  }

  /** A Module queue's name; one nobody configured starts at its recommended concurrency. */
  #moduleQueue(queue: ModuleQueue): string {
    const name = moduleQueue(queue.moduleId, queue.kind);
    if (!this.runs.queues().some((state) => state.name === name)) {
      this.runs.configure(name, {
        concurrency: MODULE_QUEUE_DEFAULTS[queue.kind],
      });
    }
    return name;
  }

  async close() {
    // Drain first: a save admitted during quit commits, so its run must end
    // complete, not cancelled under it. Then close what the engine holds.
    await this.#engine.stop();
    await this.#engine.dispose();
  }
}
