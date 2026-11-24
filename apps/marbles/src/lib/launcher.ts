import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  type ProcessIdentity,
  sameProcess,
  thisProcess,
} from "@foundry/lib/process-identity";
import type { Container } from "@foundry/sandbox/container/containers";
import { asRun, callingRun } from "~/lib/calling-run";
import { SETTLED_EXECUTION_STATUSES } from "~/lib/execution-statuses";
import type { ExecutionView } from "~/lib/execution-store";
import type { ExecutionRun, Executions } from "~/lib/executions";
import { DEFAULT_QUEUE } from "~/lib/executions";
import { errorCode } from "~/lib/observations";
import type { TaskContext, TaskDefinition } from "~/lib/tasks";
import type { Agents, SandboxHandle } from "~/lib/types";
import type { ExecutionContext } from "./execution-context";
import { withinContext } from "./execution-context";

export interface LaunchOptions {
  readonly correlation?: Readonly<Record<string, string>>;
  readonly queue?: string;
  readonly recordErrorMessage?: boolean;
  readonly source?: string;
  readonly triggerId?: string;
}

export interface Launched<O> {
  readonly id: string;
  readonly result: Promise<O>;
}

export interface DispatchedRun {
  cancel(): Promise<void>;
  endedAs(): "cancelled" | "failed" | undefined;
  readonly result: Promise<unknown>;
}

interface WorkflowDispatch {
  cancel(id: string): Promise<void>;
  dispatch(
    run: ExecutionRun,
    input: unknown,
    signal: AbortSignal
  ): Promise<DispatchedRun>;
  has(name: string): boolean;
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
  readonly recoverQueued: boolean;
  readonly sandbox: (
    container: Container,
    signal: AbortSignal
  ) => SandboxHandle;
  readonly workflows: WorkflowDispatch;
}

interface Owed extends PromiseWithResolvers<unknown> {
  readonly recordErrorMessage: boolean;
}

type Live =
  | {
      readonly controller?: AbortController;
      readonly kind: "workflow";
      readonly dispatched: Promise<DispatchedRun | undefined>;
    }
  | {
      readonly controller: AbortController;
      done: Promise<void>;
      readonly kind: "task";
      released: boolean;
    };

type Ending = "cancelled" | "failed" | undefined;

export class RunNotRecordedError extends Error {
  override readonly name = "RunNotRecordedError";

  constructor(id: string, cause: unknown) {
    super(
      `run ${id} ended, but how it ended could not be recorded: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
  }
}

class EngineRetiringError extends Error {
  override readonly name = "EngineRetiringError";

  constructor(name: string) {
    super(
      `${name} was not launched: this engine is retiring; launch it on the next engine generation`
    );
  }
}

const HAND_OVER_RETRY_MS = 1000;
const HAND_OVER_RETRY_MAX_MS = 30_000;
const HAND_OVER_PASS_MS = 2000;

interface Admission {
  readonly controller: AbortController;
  readonly settled: PromiseWithResolvers<void>;
}

export type QueuedTake =
  | { readonly taken: true }
  | { readonly taken: false; readonly why: string };

type Halting = "stop" | "cancel" | undefined;

export class Launcher {
  readonly executions: Executions;
  readonly #options: LauncherOptions;
  readonly #tasks = new Map<string, TaskDefinition>();
  readonly #owed = new Map<string, Owed>();
  readonly #live = new Map<string, Live>();
  readonly #admitted = new Map<string, Admission>();
  readonly #withdrawing: Promise<void>[] = [];
  #halting: Halting;
  #retiring = false;
  readonly #launching = new Set<Promise<void>>();
  readonly #handingOver = new Set<ReturnType<typeof setTimeout>>();

  constructor(options: LauncherOptions) {
    this.#options = options;
    this.executions = options.executions;
  }

  has(name: string): boolean {
    return this.#tasks.has(name);
  }

  task(definition: TaskDefinition): void {
    this.#tasks.set(definition.name, definition);
  }

  #runnable(name: string): boolean {
    return this.#tasks.has(name) || this.#options.workflows.has(name);
  }

  #runnableAs(run: Pick<ExecutionRun, "kind" | "name">): boolean {
    return run.kind === "task"
      ? this.#tasks.has(run.name)
      : this.#options.workflows.has(run.name);
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
    const admitted = Promise.withResolvers<void>();
    const done = () => {
      this.#launching.delete(admitted.promise);
      admitted.resolve();
    };
    this.#launching.add(admitted.promise);
    try {
      return await this.#launch<O>(name, input, options, done, parent);
    } finally {
      done();
    }
  }

  async #launch<O>(
    name: string,
    input: unknown,
    options: LaunchOptions,
    admitted: () => void,
    parent: string | undefined
  ): Promise<Launched<O>> {
    const task = this.#tasks.get(name);
    const { existing, run } = await this.executions.enqueue({
      correlation: {
        ...options.correlation,
        ...(options.triggerId === undefined
          ? {}
          : { triggerId: options.triggerId }),
      },
      input,
      kind: task ? "task" : "workflow",
      name,
      queue: options.queue ?? task?.queue ?? DEFAULT_QUEUE,
      ...(options.source === undefined ? {} : { source: options.source }),
    });
    if (existing) {
      admitted();
      return { id: run.id, result: this.#resultOf<O>(run) };
    }
    const owed = this.#owe(run.id, options.recordErrorMessage ?? true);
    const started = this.#admit(run.id, parent);
    admitted();
    if (started) {
      await started;
    }
    return { id: run.id, result: owed.promise as Promise<O> };
  }

  follow(id: string, dispatched: DispatchedRun): void {
    this.#live.set(id, {
      dispatched: Promise.resolve(dispatched),
      kind: "workflow",
    });
    this.#finish(id, dispatched.result, dispatched.endedAs);
  }

  async recover(options: {
    readonly adopted: ReadonlySet<string>;
    readonly fileStatus: (run: ExecutionRun) => string | undefined;
  }): Promise<void> {
    const readmitted = await this.executions.recover({
      adopted: options.adopted,
      fileStatus: options.fileStatus,
      readmit: (run) =>
        (this.#options.recoverQueued ||
          sameProcess(run.owner, thisProcess())) &&
        this.#runnableAs(run),
    });
    for (const run of readmitted) {
      this.#options.print(`[run] ${run.name} queued again ${run.id}`);
      this.#owe(run.id, true);
      this.#admit(run.id);
    }
  }

  async handOver(
    successor: ProcessIdentity,
    onHanded: (id: string) => void = () => undefined
  ): Promise<readonly string[]> {
    this.beginRetiring();
    const handed: string[] = [];
    const told = (id: string) => {
      handed.push(id);
      this.#pay(
        id,
        new Error(`run ${id} was handed to the next engine generation`)
      );
    };
    await Promise.all(this.#launching);
    const { failed } = await this.executions.handOverAll(
      () => Promise.resolve(successor),
      told
    );
    const said = new Set<string>();
    this.#sayFailed(failed, said);
    this.#handOverLater(
      (view) =>
        view.successor === undefined
          ? Promise.resolve(successor)
          : view.successor(),
      onHanded,
      said,
      failed.length > 0 ? HAND_OVER_RETRY_MS : HAND_OVER_PASS_MS
    );
    return [...handed];
  }

  #sayFailed(
    failed: readonly { readonly error: unknown; readonly id: string }[],
    said: Set<string>
  ): void {
    for (const { error, id } of failed) {
      const why = error instanceof Error ? error.message : String(error);
      if (!said.has(why)) {
        said.add(why);
        this.#options.print(
          `[run] ${id} not handed to the next engine generation: ${why}; it stays queued here, unstarted, and is tried again`
        );
      }
    }
  }

  #handOverLater(
    choose: (view: ExecutionView) => Promise<ProcessIdentity | undefined>,
    onHanded: (id: string) => void,
    said: Set<string>,
    delay: number
  ): void {
    if (this.#handedAll()) {
      return;
    }
    const timer = setTimeout(async () => {
      this.#handingOver.delete(timer);
      if (this.#handedAll()) {
        return;
      }
      const told = (id: string) => {
        this.#pay(
          id,
          new Error(`run ${id} was handed to the next engine generation`)
        );
        onHanded(id);
      };
      let failed: readonly { readonly error: unknown; readonly id: string }[];
      try {
        await this.#takeUpQueued();
        ({ failed } = await this.executions.handOverAll(choose, told));
      } catch (error) {
        failed = [{ error, id: "a queued run" }];
      }
      this.#sayFailed(failed, said);
      this.#handOverLater(
        choose,
        onHanded,
        said,
        failed.length === 0
          ? HAND_OVER_PASS_MS
          : Math.min(
              delay === HAND_OVER_PASS_MS ? HAND_OVER_RETRY_MS : delay * 2,
              HAND_OVER_RETRY_MAX_MS
            )
      );
    }, delay);
    timer.unref?.();
    this.#handingOver.add(timer);
  }

  #handedAll(): boolean {
    return (
      this.#halting === "cancel" ||
      (this.#halting === "stop" && this.executions.waiting().length === 0)
    );
  }

  #stopHandingOver(): void {
    if (!this.#handedAll()) {
      return;
    }
    for (const timer of this.#handingOver) {
      clearTimeout(timer);
    }
    this.#handingOver.clear();
  }

  async #takeUpQueued(): Promise<void> {
    for (const id of await this.executions.queuedHere()) {
      if (this.#owed.has(id) || this.#admitted.has(id)) {
        continue;
      }
      const run = await this.executions.readHanded(id);
      if (run === undefined || this.#owed.has(id) || this.#admitted.has(id)) {
        continue;
      }
      this.#owe(id, true);
      this.#admit(id);
    }
  }

  async takeOrphaned(id: string, owner: ProcessIdentity): Promise<QueuedTake> {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome narrows the field to its initial value; `beginRetiring` sets it.
    if (this.#retiring) {
      return { taken: false, why: "this engine is retiring" };
    }
    if (this.#owed.has(id) || this.#admitted.has(id)) {
      return { taken: true };
    }
    const stored = await this.executions.peek(id);
    if (stored === undefined) {
      return { taken: false, why: "it is no longer stored" };
    }
    if (!this.#runnableAs(stored)) {
      return {
        taken: false,
        why: `no ${stored.kind} named "${stored.name}" is registered here`,
      };
    }
    const run = await this.executions.takeQueuedFrom(id, owner);
    if (run === undefined) {
      return {
        taken: false,
        why: "it is no longer queued under a process proved gone",
      };
    }
    if (this.#owed.has(id) || this.#admitted.has(id)) {
      return { taken: true };
    }
    this.#options.print(
      `[run] ${run.name} taken over from a gone process ${id}`
    );
    this.#owe(id, true);
    this.#admit(id);
    return { taken: true };
  }

  async takeHanded(id: string): Promise<boolean | undefined> {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome narrows the field to its initial value; `beginRetiring` sets it.
    if (this.#retiring) {
      return false;
    }
    if (this.#owed.has(id) || this.#admitted.has(id)) {
      return true;
    }
    const run = await this.executions.readHanded(id);
    if (run === undefined) {
      return;
    }
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome narrows the field to its initial value; `beginRetiring` sets it.
    if (this.#retiring || !this.#runnableAs(run)) {
      return false;
    }
    if (this.#owed.has(id) || this.#admitted.has(id)) {
      return true;
    }
    this.#options.print(`[run] ${run.name} handed over ${id}`);
    this.#owe(id, true);
    this.#admit(id);
    return true;
  }

  async cancel(id: string): Promise<void> {
    if (await this.executions.withdraw(id)) {
      this.#pay(id, new Error(`run ${id} was cancelled before it started`));
      return;
    }
    const live = this.#live.get(id);
    if (live?.kind === "task") {
      live.controller.abort(new Error(`run ${id} was cancelled`));
      await live.done;
      return;
    }
    const admission = this.#admitted.get(id);
    if (!live && admission) {
      admission.controller.abort(new Error(`run ${id} was cancelled`));
      await admission.settled.promise;
      return;
    }
    live?.controller?.abort(new Error(`run ${id} was cancelled`));
    const dispatched = await live?.dispatched;
    if (dispatched) {
      await dispatched.cancel();
      return;
    }
    const run = this.executions.get(id);
    if (run && SETTLED_EXECUTION_STATUSES.has(run.status)) {
      return;
    }
    if (await this.executions.cancelOrphan(id)) {
      return;
    }
    if (run?.kind === "task") {
      throw new Error(`run ${id} is not running in this process`);
    }
    await this.#options.workflows.cancel(id);
  }

  cancelPending(): void {
    this.#halting = "cancel";
    for (const id of this.executions.waiting()) {
      this.#withdrawing.push(
        this.executions.withdraw(id).then(
          (cancelled) => {
            if (cancelled) {
              this.#pay(
                id,
                new Error(`run ${id} was cancelled before it started`)
              );
            }
          },
          (error: unknown) => this.#pay(id, error)
        )
      );
    }
    for (const [id, live] of this.#live) {
      live.controller?.abort(new Error(`run ${id} stopped with the engine`));
    }
  }

  async halt(cancel: boolean): Promise<void> {
    if (cancel) {
      this.cancelPending();
    } else {
      this.#halting ??= "stop";
    }
    this.#abortHalted();
    await Promise.all(this.#withdrawing.splice(0));
    await Promise.all(
      [...this.#live.values()].map((live) =>
        live.kind === "workflow" ? live.dispatched : undefined
      )
    );
    this.#abortHalted();
    this.#stopHandingOver();
  }

  #abortHalted(): void {
    for (const [id, live] of this.#live) {
      if (
        live.kind === "task" &&
        (this.#halting === "cancel" || live.released)
      ) {
        live.controller.abort(new Error(`run ${id} stopped with the engine`));
      }
    }
  }

  async settled(): Promise<void> {
    await Promise.all(
      [...this.#live.values()].map((live) =>
        live.kind === "task" ? live.done : undefined
      )
    );
    this.#stopHandingOver();
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

  #pay(id: string, error: unknown, value?: unknown): void {
    const admission = this.#admitted.get(id);
    this.#admitted.delete(id);
    admission?.settled.resolve();
    const owed = this.#owed.get(id);
    this.#owed.delete(id);
    if (error === undefined) {
      owed?.resolve(value);
    } else {
      owed?.reject(error);
    }
  }

  owedResult(id: string): Promise<unknown> | undefined {
    return this.#owed.get(id)?.promise;
  }

  #resultOf<O>(run: ExecutionRun): Promise<O> {
    const owed = this.#owed.get(run.id);
    if (owed) {
      return owed.promise as Promise<O>;
    }
    if (run.status === "complete") {
      return Promise.resolve(undefined as O);
    }
    return Promise.reject(
      new Error(`run ${run.id} is ${run.status}; its value is not held here`)
    );
  }

  #admit(id: string, parent?: string): Promise<void> | undefined {
    if (this.executions.get(id)?.status !== "queued") {
      this.#pay(id, new Error(`run ${id} was cancelled before it started`));
      return;
    }
    const admission: Admission = {
      controller: new AbortController(),
      settled: Promise.withResolvers<void>(),
    };
    this.#admitted.set(id, admission);
    return this.executions.admit(
      id,
      AsyncResource.bind((input: unknown) =>
        this.#start(id, input, admission.controller)
      ),
      (error) => this.#pay(id, error),
      parent
    );
  }

  #activeCaller(): string | undefined {
    const id = callingRun();
    return id !== undefined && this.#active(id) ? id : undefined;
  }

  #active(id: string): boolean {
    const run = this.executions.get(id);
    return (
      this.#live.has(id) &&
      run?.status === "running" &&
      sameProcess(run.owner, thisProcess())
    );
  }

  beginRetiring(): void {
    this.#retiring = true;
    this.executions.closeAdmission((id) => this.#active(id));
  }

  #start(
    id: string,
    input: unknown,
    controller: AbortController
  ): Promise<void> {
    const run = this.executions.get(id);
    if (!run) {
      return Promise.reject(new Error(`execution run ${id} is not recorded`));
    }
    if (run.kind === "workflow") {
      return this.#dispatch(run, input, controller);
    }
    const task = this.#tasks.get(run.name);
    if (!task) {
      const error = new Error(
        `run ${id}: no task is registered as ${run.name}`
      );
      return this.#end(id, "failed", { error }).then(() => {
        throw error;
      });
    }
    this.#run(task, run, input, controller);
    return Promise.resolve();
  }

  async #dispatch(
    run: ExecutionRun,
    input: unknown,
    controller: AbortController
  ): Promise<void> {
    if (this.#halting === "cancel") {
      controller.abort(new Error(`run ${run.id} stopped with the engine`));
    }
    const outcome = Promise.withResolvers<DispatchedRun | undefined>();
    this.#live.set(run.id, {
      controller,
      dispatched: outcome.promise,
      kind: "workflow",
    });
    let dispatched: DispatchedRun | undefined;
    try {
      dispatched = await this.#options.workflows.dispatch(
        run,
        input,
        controller.signal
      );
    } catch (error) {
      this.#live.delete(run.id);
      if (controller.signal.aborted) {
        await this.#end(run.id, "cancelled", {
          error: new Error(`run ${run.id} was cancelled`),
        });
        return;
      }
      await this.#end(run.id, "failed", { error });
      throw error;
    } finally {
      outcome.resolve(dispatched);
    }
    this.#finish(run.id, dispatched.result, dispatched.endedAs);
  }

  #run(
    task: TaskDefinition,
    run: ExecutionRun,
    input: unknown,
    controller: AbortController
  ): void {
    const { id } = run;
    if (this.#halting === "cancel") {
      controller.abort(new Error(`run ${id} stopped with the engine`));
    }
    const lifetime = new AbortController();
    const resourceSignal = AbortSignal.any([
      controller.signal,
      lifetime.signal,
    ]);
    const opened = new Set<Closable>();
    const live: Live & { kind: "task" } = {
      controller,
      done: Promise.resolve(),
      kind: "task",
      released: false,
    };
    const context: TaskContext = {
      agents: this.#options.agents({
        id,
        name: run.name,
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
      release: () => {
        live.released = true;
        this.executions.release(id);
        if (this.#halting !== undefined) {
          queueMicrotask(() =>
            controller.abort(new Error(`run ${id} stopped with the engine`))
          );
        }
      },
      run,
      sandbox: (container) => this.#options.sandbox(container, resourceSignal),
      signal: resourceSignal,
    };
    this.#live.set(id, live);
    const result = withinContext(this.#options.context, async () => {
      let value: unknown;
      try {
        controller.signal.throwIfAborted();
        value = await asRun(id, () => task.run(input, context));
      } finally {
        lifetime.abort(new Error(`run ${id} resource lifetime ended`));
        for (const closable of [...opened].reverse()) {
          await Promise.resolve()
            .then(() => closable.close())
            .catch(() => undefined);
        }
      }
      if (controller.signal.aborted) {
        throw new Error(`run ${id} was cancelled`);
      }
      return value;
    });
    live.done = this.#finish(id, result, () =>
      controller.signal.aborted ? "cancelled" : "failed"
    );
  }

  #finish(
    id: string,
    result: Promise<unknown>,
    endedAs: (error: unknown) => Ending
  ): Promise<void> {
    return result.then(
      async (value) => {
        this.#live.delete(id);
        await this.#end(id, "complete", { value });
      },
      async (error: unknown) => {
        this.#live.delete(id);
        await this.#end(id, endedAs(error), { error });
      }
    );
  }

  async #end(
    id: string,
    ending: "complete" | Ending,
    outcome: { readonly error?: unknown; readonly value?: unknown }
  ): Promise<void> {
    if (ending !== undefined) {
      let stored: ExecutionRun | undefined;
      try {
        stored = await this.executions.settle(
          id,
          ending,
          ending === "failed" ? this.#failure(id, outcome.error) : undefined
        );
      } catch (failure) {
        this.#pay(id, new RunNotRecordedError(id, failure));
        return;
      }
      if (stored && stored.status !== ending) {
        this.#pay(
          id,
          stored.status === "complete"
            ? undefined
            : new Error(`run ${id} was ${stored.status} already`),
          undefined
        );
        return;
      }
    }
    this.#pay(id, outcome.error, outcome.value);
  }

  #failure(id: string, error: unknown): { code: string; message?: string } {
    const code = errorCode(error);
    if (this.#owed.get(id)?.recordErrorMessage === false) {
      return { code };
    }
    return {
      code,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
