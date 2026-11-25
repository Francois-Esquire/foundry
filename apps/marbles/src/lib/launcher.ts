import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { ProcessIdentity } from "@foundry/lib/node/process-identity";
import { sameProcess } from "@foundry/lib/node/process-identity";
import type { Job, RecoverySummary, RunOutcome } from "@foundry/queue";
import type { QueueHandlerContext } from "@foundry/queue/client";
import type { Container } from "@foundry/sandbox";
import { asRun, callingRun } from "~/lib/calling-run";
import type { ExecutionRun } from "~/lib/execution-record";
import { DEFAULT_POOL, isTask, linksOf } from "~/lib/execution-record";
import { SETTLED_EXECUTION_STATUSES } from "~/lib/execution-statuses";
import type { Executions } from "~/lib/executions";
import { errorCode } from "~/lib/observations";
import type { RunQueue, SubmitOptions } from "~/lib/run-queue";
import { storableJson } from "~/lib/state/json";
import type { TaskContext, TaskDefinition } from "~/lib/tasks";
import type { Agents, SandboxHandle } from "~/lib/types";
import type { ExecutionContext } from "./execution-context";
import { withinContext } from "./execution-context";

export interface DefinitionLaunch {
  readonly key?: string;
}

export interface LaunchOptions {
  readonly correlation?: Readonly<Record<string, string>>;
  readonly idempotencyKey?: string;
  readonly pool?: string;
  readonly recordErrorMessage?: boolean;
  readonly source?: string;
  readonly triggerId?: string;
}

export interface Launched<O> {
  readonly id: string;
  readonly result: Promise<O>;
  readonly reused?: true;
}

export interface DispatchedRun {
  readonly result: Promise<unknown>;
}

interface WorkflowDispatch {
  cancel(id: string, reason: string): Promise<void>;
  dispatch(
    name: string,
    input: unknown,
    options: SubmitOptions
  ): Promise<{ readonly dispatched?: DispatchedRun; readonly job: Job }>;
  has(name: string): boolean;
  poolOf(name: string): string | undefined;
}

interface TaskRunSite {
  readonly id: string;
  readonly name: string;
  retain(closable: Closable): void;
  readonly signal: AbortSignal;
}

interface Closable {
  close(): Promise<void> | void;
}

export interface LauncherOptions {
  readonly agents: (run: TaskRunSite) => Agents;
  readonly context?: ExecutionContext;
  readonly executions: Executions;
  readonly print: (line: string) => void;
  readonly sandbox: (
    container: Container,
    signal: AbortSignal
  ) => SandboxHandle;
  readonly workflows: WorkflowDispatch;
}

interface Owed extends PromiseWithResolvers<unknown> {
  readonly recordErrorMessage: boolean;
}

type TaskEnding =
  | { readonly kind: "complete"; readonly value: unknown }
  | { readonly kind: "failed"; readonly error: unknown };

class EngineRetiringError extends Error {
  override readonly name = "EngineRetiringError";

  constructor(name: string) {
    super(
      `${name} was not launched: this engine is retiring; launch it on the next engine generation`
    );
  }
}

export type QueuedAdoption =
  | { readonly taken: true }
  | { readonly taken: false; readonly why: string };

export const idempotencyKeyOf = (name: string, source: string): string =>
  JSON.stringify([name, source]);

const isRetiring = (error: unknown): boolean =>
  error instanceof Error &&
  "_tag" in error &&
  error._tag === "QueueRetiringError";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function submitOptionsOf(
  runId: string,
  idempotencyKey: string | undefined,
  task: TaskDefinition | undefined,
  options: LaunchOptions,
  parent: string | undefined,
  definitionPool: string | undefined
): SubmitOptions {
  const { correlation, pool, source, triggerId } = options;
  return {
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    links: linksOf({
      ...(correlation === undefined ? {} : { correlation }),
      kind: task ? "task" : "workflow",
      ...(parent?.startsWith("rn-")
        ? { parentRunId: parent as `rn-${string}` }
        : {}),
      ...(source === undefined ? {} : { source }),
      ...(triggerId === undefined ? {} : { triggerId }),
    }),
    pool: pool ?? task?.pool ?? definitionPool ?? DEFAULT_POOL,
    runId,
  };
}

const cancelledBefore = (id: string) =>
  `run ${id} was cancelled before it started`;

export class Launcher {
  readonly executions: Executions;
  readonly #options: LauncherOptions;
  readonly #tasks = new Map<string, TaskDefinition>();
  readonly #registered = new Map<string, Promise<void>>();
  readonly #owed = new Map<string, Owed>();
  readonly #inputs = new Map<string, unknown>();
  readonly #contexts = new Map<string, AsyncResource>();
  readonly #endings = new Map<string, TaskEnding>();
  readonly #reasons = new Map<string, string>();
  readonly #settlingTasks = new Set<string>();
  readonly #live = new Map<string, Promise<void>>();
  readonly #launching = new Set<Promise<void>>();
  readonly #dispatching = new Set<string>();
  readonly #waiters = new Set<{
    readonly inRun: boolean;
    readonly reject: (reason: Error) => void;
  }>();
  #closedExternal: Error | undefined;
  #closedAll: Error | undefined;
  #queue: RunQueue | undefined;
  #retiring = false;
  #cancelling = false;

  constructor(options: LauncherOptions) {
    this.#options = options;
    this.executions = options.executions;
  }

  has(name: string): boolean {
    return this.#tasks.has(name);
  }

  task(definition: TaskDefinition): void {
    this.#tasks.set(definition.name, definition);
    if (this.#queue !== undefined) {
      this.#register(this.#queue, definition);
    }
  }

  async attach(queue: RunQueue): Promise<void> {
    this.#queue = queue;
    for (const task of this.#tasks.values()) {
      this.#register(queue, task);
    }
    await Promise.all(this.#registered.values());
  }

  #register(queue: RunQueue, task: TaskDefinition): void {
    const registered = queue.registerTask(task.name, (context) =>
      this.#handle(task, context)
    );
    registered.catch(() => undefined);
    this.#registered.set(task.name, registered);
  }

  #runnable(name: string): boolean {
    return this.#tasks.has(name) || this.#options.workflows.has(name);
  }

  async launch<O>(
    name: string,
    input: unknown,
    options: LaunchOptions
  ): Promise<Launched<O>> {
    if (!this.#runnable(name)) {
      throw new Error(`Definition is not registered: ${name}`);
    }
    const parent = this.#activeCaller();
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome narrows the field to its initial value; `beginRetiring` sets it.
    if (this.#retiring && parent === undefined) {
      throw new EngineRetiringError(name);
    }
    const launching = this.#launch<O>(name, input, options, parent);
    const tracked = launching.then(
      () => undefined,
      () => undefined
    );
    this.#launching.add(tracked);
    try {
      return await launching;
    } finally {
      this.#launching.delete(tracked);
    }
  }

  async #launch<O>(
    name: string,
    input: unknown,
    options: LaunchOptions,
    parent: string | undefined
  ): Promise<Launched<O>> {
    const queue = this.#requireQueue();
    const task = this.#tasks.get(name);
    const idempotencyKey =
      options.idempotencyKey ??
      (options.source === undefined
        ? undefined
        : idempotencyKeyOf(name, options.source));
    const existing =
      idempotencyKey === undefined
        ? undefined
        : await this.#existing(queue, idempotencyKey);
    if (existing !== undefined) {
      return existing as Launched<O>;
    }
    const runId = `rn-${randomUUID()}`;
    const submit = submitOptionsOf(
      runId,
      idempotencyKey,
      task,
      options,
      parent,
      this.#options.workflows.poolOf(name)
    );
    const owed = this.#owe(runId, options.recordErrorMessage ?? true);
    let job: Job;
    try {
      job = await this.#submit(queue, name, input, task, submit);
    } catch (error) {
      this.#unowe(runId);
      throw isRetiring(error) ? new EngineRetiringError(name) : error;
    }
    if (this.executions.get(runId) === undefined) {
      await this.executions.refresh(runId);
    }
    if (this.executions.get(runId) === undefined && idempotencyKey) {
      this.#unowe(runId);
      return (await this.#existing(queue, idempotencyKey, job)) as Launched<O>;
    }
    if (task) {
      this.#settleTask(runId);
    }
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome narrows the field to its initial value; `cancelPending` sets it.
    if (this.#cancelling) {
      await this.#cancelRun(runId, cancelledBefore(runId));
      await this.#refreshed(runId);
    }
    return { id: runId, result: owed.promise as Promise<O> };
  }

  async #submit(
    queue: RunQueue,
    name: string,
    input: unknown,
    task: TaskDefinition | undefined,
    submit: SubmitOptions
  ): Promise<Job> {
    const { runId } = submit;
    if (task) {
      await this.#registered.get(name);
      this.#inputs.set(runId, input);
      this.#contexts.set(runId, new AsyncResource("marbles.task"));
      return await queue.submit(
        name,
        storableJson(`the input of run ${runId}`, input ?? null),
        submit
      );
    }
    this.#dispatching.add(runId);
    try {
      const { dispatched, job } = await asRun(runId, () =>
        this.#options.workflows.dispatch(name, input, submit)
      );
      if (dispatched !== undefined) {
        this.#follow(runId, dispatched.result);
      }
      return job;
    } finally {
      this.#dispatching.delete(runId);
    }
  }

  async #existing(
    queue: RunQueue,
    idempotencyKey: string,
    known?: Job
  ): Promise<Launched<unknown> | undefined> {
    const job =
      known ?? (await queue.listJobs({ idempotencyKey })).find(Boolean);
    if (job === undefined) {
      return;
    }
    const runs = await queue.listRuns({ jobId: job.id });
    const run = runs.reduce<(typeof runs)[number] | undefined>(
      (last, each) =>
        last === undefined || each.attempt > last.attempt ? each : last,
      undefined
    );
    if (run === undefined) {
      return;
    }
    await this.executions.refresh(run.id);
    return { id: run.id, result: this.resultOf(run.id), reused: true };
  }

  follow(id: string, dispatched: DispatchedRun): void {
    if (!this.#owed.has(id)) {
      this.#owe(id, true);
    }
    this.#follow(id, dispatched.result);
  }

  #follow(id: string, result: Promise<unknown>): void {
    result.then(
      async (value) => {
        await this.#refreshed(id);
        this.#pay(id, undefined, value);
      },
      async (error: unknown) => {
        await this.#refreshed(id);
        this.#pay(id, error);
      }
    );
  }

  #settleTask(id: string): void {
    if (this.#settlingTasks.has(id)) {
      return;
    }
    this.#settlingTasks.add(id);
    this.executions
      .settled(id)
      .then((settled) => {
        const ending = this.#endings.get(id);
        this.#endings.delete(id);
        this.#inputs.delete(id);
        this.#contexts.delete(id);
        const reason = this.#endedWith(settled);
        this.#reasons.delete(id);
        if (settled.status === "complete") {
          this.#pay(
            id,
            undefined,
            ending?.kind === "complete" ? ending.value : undefined
          );
        } else if (ending?.kind === "failed" && settled.status === "failed") {
          this.#pay(id, ending.error);
        } else {
          this.#pay(id, new Error(reason));
        }
      })
      .catch((error: unknown) => {
        this.#endings.delete(id);
        this.#inputs.delete(id);
        this.#contexts.delete(id);
        this.#reasons.delete(id);
        this.#pay(id, error);
      })
      .finally(() => this.#settlingTasks.delete(id));
  }

  #endedWith(run: ExecutionRun): string {
    if (run.status === "cancelled") {
      return this.#reasons.get(run.id) ?? `run ${run.id} was cancelled`;
    }
    return `run ${run.id} ${run.status}${run.error?.message === undefined ? "" : `: ${run.error.message}`}`;
  }

  async #refreshed(id: string): Promise<void> {
    await this.executions.refresh(id).catch(() => undefined);
  }

  async recover(): Promise<RecoverySummary> {
    const summary = await this.#requireQueue().recover();
    for (const id of summary.adopted) {
      const run = this.executions.get(id) ?? (await this.executions.peek(id));
      if (run !== undefined) {
        this.#options.print(`[run] ${run.name} queued again ${id}`);
      }
    }
    for (const id of summary.interrupted) {
      const run = await this.executions.peek(id);
      if (run !== undefined) {
        this.#options.print(
          `[run] ${run.name} ${id} closed out: ${run.error?.message ?? "its owner is gone"}`
        );
      }
    }
    return summary;
  }

  async handOver(successor: ProcessIdentity): Promise<readonly string[]> {
    this.beginRetiring();
    await Promise.all(this.#launching);
    const handed = await this.#requireQueue().retire(successor);
    for (const id of handed) {
      await this.#refreshed(id);
      this.#pay(
        id,
        new Error(`run ${id} was handed to the next engine generation`)
      );
    }
    return handed;
  }

  async adoptQueued(
    id: string,
    owner: ProcessIdentity
  ): Promise<QueuedAdoption> {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome narrows the field to its initial value; `beginRetiring` sets it.
    if (this.#retiring) {
      return { taken: false, why: "this engine is retiring" };
    }
    const queue = this.#requireQueue();
    const run = await this.executions.peek(id);
    if (run === undefined) {
      return { taken: false, why: "it is no longer stored" };
    }
    if (!this.#runnable(run.name)) {
      return {
        taken: false,
        why: `no ${run.kind} named "${run.name}" is registered here`,
      };
    }
    if (
      run.status !== "queued" ||
      (run.owner !== undefined && !sameProcess(run.owner, owner))
    ) {
      return {
        taken: false,
        why: "it is no longer queued under a process proved gone",
      };
    }
    await queue.recover();
    const taken = await this.executions.peek(id);
    if (taken?.status === "queued" && !this.#ours(id)) {
      return {
        taken: false,
        why: "it is no longer queued under a process proved gone",
      };
    }
    this.#options.print(
      `[run] ${run.name} taken over from a gone process ${id}`
    );
    return { taken: true };
  }

  async takeHanded(id: string): Promise<boolean | undefined> {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome narrows the field to its initial value; `beginRetiring` sets it.
    if (this.#retiring) {
      return false;
    }
    const run = await this.executions.peek(id);
    if (run === undefined) {
      return;
    }
    if (!this.#runnable(run.name)) {
      return false;
    }
    if (run.status === "queued" && this.#ours(id)) {
      this.#options.print(`[run] ${run.name} handed over ${id}`);
    }
    return true;
  }

  async cancel(id: string): Promise<void> {
    const run = this.executions.get(id) ?? (await this.executions.peek(id));
    if (run === undefined) {
      throw new Error(`run ${id} is not recorded here`);
    }
    if (SETTLED_EXECUTION_STATUSES.has(run.status)) {
      return;
    }
    const reason =
      run.status === "queued" ? cancelledBefore(id) : `run ${id} was cancelled`;
    if (run.kind === "workflow") {
      await this.#options.workflows.cancel(id, reason);
    } else {
      await this.#cancelRun(id, reason);
    }
    await this.#live.get(id);
    await this.#refreshed(id);
  }

  async cancelPending(): Promise<void> {
    this.#cancelling = true;
    const queue = this.#queue;
    if (queue === undefined) {
      return;
    }
    await queue.pause();
    const owned = this.#pending();
    for (const run of owned.filter((each) => each.status === "queued")) {
      await this.#cancelOwned(run, cancelledBefore(run.id));
    }
    await Promise.all(
      owned
        .filter((each) => each.status !== "queued")
        .map((run) =>
          this.#cancelOwned(run, `run ${run.id} stopped with the engine`)
        )
    );
  }

  async #cancelOwned(run: ExecutionRun, reason: string): Promise<void> {
    await this.#cancelRun(run.id, reason).catch((error: unknown) => {
      this.#options.print(`[run] ${run.id} not cancelled: ${String(error)}`);
    });
    await this.#live.get(run.id);
    await this.#refreshed(run.id);
  }

  async idle(): Promise<void> {
    await Promise.all(this.#launching);
    while (this.#pending().length > 0) {
      const changed = Promise.withResolvers<void>();
      const unwatch = this.executions.watch(() => changed.resolve());
      try {
        const pending = this.#pending();
        await Promise.all(pending.map((run) => this.#refreshed(run.id)));
        if (this.#pending().length > 0) {
          await Promise.race([
            changed.promise,
            ...pending.map((run) =>
              this.executions.settled(run.id).catch(() => undefined)
            ),
          ]);
        }
      } finally {
        unwatch();
      }
    }
    await Promise.all(this.#live.values());
  }

  beginRetiring(): void {
    this.#retiring = true;
  }

  #owe(id: string, recordErrorMessage: boolean): Owed {
    const owed: Owed = {
      ...Promise.withResolvers<unknown>(),
      recordErrorMessage,
    };
    owed.promise.catch(() => undefined);
    this.#owed.set(id, owed);
    return owed;
  }

  #unowe(id: string): void {
    this.#owed.delete(id);
    this.#inputs.delete(id);
    this.#contexts.delete(id);
  }

  #pay(id: string, error: unknown, value?: unknown): void {
    const owed = this.#owed.get(id);
    this.#owed.delete(id);
    if (error === undefined) {
      owed?.resolve(value);
    } else {
      owed?.reject(error);
    }
  }

  close(reason: Error, options?: { readonly externalOnly?: boolean }): void {
    this.#closedExternal ??= reason;
    if (!options?.externalOnly) {
      this.#closedAll ??= reason;
    }
    const target = options?.externalOnly
      ? this.#closedExternal
      : this.#closedAll;
    for (const waiter of [...this.#waiters]) {
      if (options?.externalOnly && waiter.inRun) {
        continue;
      }
      this.#waiters.delete(waiter);
      waiter.reject(target ?? reason);
    }
  }

  resultOf(id: string): Promise<unknown> {
    const owed = this.#owed.get(id);
    if (owed !== undefined) {
      return owed.promise;
    }
    const inRun = this.#activeCaller() !== undefined;
    const result = this.#settledResult(id, inRun);
    result.catch(() => undefined);
    return result;
  }

  async #settledResult(id: string, inRun: boolean): Promise<unknown> {
    const closed = inRun
      ? this.#closedAll
      : (this.#closedAll ?? this.#closedExternal);
    if (closed !== undefined) {
      throw closed;
    }
    const aborted = Promise.withResolvers<never>();
    aborted.promise.catch(() => undefined);
    const waiter = { inRun, reject: aborted.reject };
    this.#waiters.add(waiter);
    let settled: Awaited<ReturnType<RunQueue["settled"]>>;
    try {
      settled = await Promise.race([
        this.#requireQueue().settled(id),
        aborted.promise,
      ]);
    } finally {
      this.#waiters.delete(waiter);
    }
    if (settled.status === "complete") {
      return settled.value;
    }
    if (settled.status === "failed" && settled.error instanceof Error) {
      throw new Error(`run ${id} failed: ${settled.error.message}`);
    }
    const run = await this.executions.peek(id);
    throw new Error(run ? this.#endedWith(run) : `run ${id} ${settled.status}`);
  }

  #activeCaller(): string | undefined {
    const id = callingRun();
    if (id === undefined || this.#dispatching.has(id)) {
      return id;
    }
    return this.executions
      .owned()
      .some((run) => run.id === id && run.status === "running")
      ? id
      : undefined;
  }

  #pending(): readonly ExecutionRun[] {
    return this.executions
      .owned()
      .filter((run) => run.status === "running" || this.#runnable(run.name));
  }

  #ours(id: string): boolean {
    return this.executions.owned().some((run) => run.id === id);
  }

  #cancelRun(id: string, reason: string): Promise<void> {
    this.#reasons.set(id, reason);
    return this.#requireQueue().cancelRun(id, reason);
  }

  #requireQueue(): RunQueue {
    if (this.#queue === undefined) {
      throw new Error("the engine has not started");
    }
    return this.#queue;
  }

  async #handle(
    task: TaskDefinition,
    context: QueueHandlerContext
  ): Promise<RunOutcome> {
    const { id } = context.run;
    if (!isTask(context.job)) {
      return {
        error: {
          message: `run ${id} was queued as a workflow; "${task.name}" is a task now`,
          name: "KindChanged",
        },
        kind: "bailed",
      };
    }
    this.#settleTask(id);
    await this.#refreshed(id);
    const input =
      this.#inputs.has(id) && this.#inputs.get(id) === undefined
        ? undefined
        : context.job.input;
    const launched = this.#contexts.get(id);
    this.#contexts.delete(id);
    const done =
      launched === undefined
        ? this.#run(task, id, input, context.signal)
        : launched.runInAsyncScope(() =>
            this.#run(task, id, input, context.signal)
          );
    const live = done.then(
      () => undefined,
      () => undefined
    );
    this.#live.set(id, live);
    try {
      const value = await done;
      this.#endings.set(id, { kind: "complete", value });
      return { kind: "complete", output: null };
    } catch (error) {
      this.#endings.set(id, { error, kind: "failed" });
      const recordMessage = this.#owed.get(id)?.recordErrorMessage ?? true;
      return {
        error: {
          message: recordMessage ? messageOf(error) : "",
          name: errorCode(error),
        },
        kind: "bailed",
      };
    } finally {
      if (this.#live.get(id) === live) {
        this.#live.delete(id);
      }
    }
  }

  #run(
    task: TaskDefinition,
    id: string,
    input: unknown,
    signal: AbortSignal
  ): Promise<unknown> {
    const lifetime = new AbortController();
    const resourceSignal = AbortSignal.any([signal, lifetime.signal]);
    const opened = new Set<Closable>();
    const run = this.executions.get(id) as ExecutionRun;
    const context: TaskContext = {
      agents: this.#options.agents({
        id,
        name: task.name,
        retain: (closable) => opened.add(closable),
        signal: resourceSignal,
      }),
      observe: (observation) =>
        this.executions.observe(
          id,
          {
            ...observation,
            id: observation.id ?? randomUUID(),
            startedAt: observation.startedAt ?? new Date().toISOString(),
            status: observation.status ?? "complete",
          },
          { keepStart: observation.startedAt === undefined }
        ),
      progress: (value) => this.executions.progress(id, value),
      run,
      sandbox: (container) => this.#options.sandbox(container, resourceSignal),
      signal: resourceSignal,
    };
    return withinContext(this.#options.context, async () => {
      try {
        signal.throwIfAborted();
        return await asRun(id, () => task.run(input, context));
      } finally {
        lifetime.abort(new Error(`run ${id} resource lifetime ended`));
        for (const closable of [...opened].reverse()) {
          await Promise.resolve()
            .then(() => closable.close())
            .catch(() => undefined);
        }
      }
    });
  }
}
