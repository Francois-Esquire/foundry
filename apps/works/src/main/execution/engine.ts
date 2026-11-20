import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ArtifactManager,
  blobFiles,
  Engine,
  type ExecutionRuns,
  type ExecutionStore,
  InMemoryArtifactStore,
  InMemorySessionStore,
  JsonArtifactStore,
  MemoryExecutionStore,
  ModelManager,
  openWorkspaceDatabase,
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

class AbandonedRequestError extends Error {
  override readonly name = "AbandonedRequest";
  constructor() {
    super("Works quit before this request started, so nothing was changed");
  }
}

export interface WorksEngineOptions {
  readonly directory?: string;
  readonly executionStore?: (store: ExecutionStore) => ExecutionStore;
  readonly models?: ModelManager;
  readonly print?: (line: string) => void;
  readonly workflows?: Pick<WorkflowRegistry, "identities">;
}

interface RunRequest {
  readonly request: string;
}

export async function startWorksEngine(
  options: WorksEngineOptions = {}
): Promise<WorksExecution> {
  const { directory } = options;
  const print = options.print ?? (() => undefined);
  const database =
    directory === undefined
      ? undefined
      : openWorkspaceDatabase({
          state: path.join(directory, "state"),
          workspaceId: "foundry-works",
        });
  try {
    if (directory !== undefined) {
      await mkdir(directory, { mode: 0o700, recursive: true });
    }
    const keptExecutions = database?.executions ?? new MemoryExecutionStore();
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
      containers: () =>
        Promise.reject(
          new Error("Borrow Module sandboxes from the Works coordinator")
        ),
      models: options.models ?? new ModelManager(),
      print,
      queues: { [SYSTEM_QUEUE]: { concurrency: Number.POSITIVE_INFINITY } },
      recoverQueued: true,
      root: directory ?? tmpdir(),
      ...(directory === undefined
        ? {}
        : { state: path.join(directory, "state") }),
      sessions: database?.sessions ?? new InMemorySessionStore(),
      ...(database === undefined
        ? {}
        : {
            activityStore: database.activityStore,
            approvals: database.approvals,
            automationStore: database.automations,
            grants: database.grants,
            records: database.records,
            recoveryLog: database.recoveryLog,
            runs: database.runs,
            triggers: database.triggers,
            usageStore: database.usage,
          }),
      executionStore:
        options.executionStore?.(keptExecutions) ?? keptExecutions,
      workspaceId: "foundry-works",
    });
    const execution = new EngineExecution(
      engine,
      options.workflows?.identities() ?? [],
      () => database?.close() ?? Promise.resolve()
    );
    try {
      await engine.start();
    } catch (error) {
      await engine.dispose().catch(() => undefined);
      throw error;
    }
    return execution;
  } catch (error) {
    await database?.close().catch(() => undefined);
    throw new WorksEngineStartError(
      `The execution engine could not start: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

class EngineExecution implements WorksExecution {
  readonly #bodies = new Map<string, RunBody<unknown>>();
  readonly #engine: Engine;
  readonly #release: () => Promise<void>;
  readonly #tasks = new Set<string>();
  readonly runs: ExecutionRuns;

  constructor(
    engine: Engine,
    tasks: readonly string[],
    release: () => Promise<void>
  ) {
    this.#release = release;
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
    this.#engine.task<RunRequest | undefined, unknown>({
      name,
      queue: SYSTEM_QUEUE,
      run: async (input, context) => {
        const body =
          input?.request === undefined
            ? undefined
            : this.#bodies.get(input.request);
        if (!body) {
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
    await this.#engine.stop();
    try {
      await this.#engine.dispose();
    } finally {
      await this.#release();
    }
  }
}
