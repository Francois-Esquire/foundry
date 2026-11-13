import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Container } from "@foundry/sandbox/container/containers";
import { SETTLED_EXECUTION_STATUSES } from "~/lib/execution-statuses";
import type { ExecutionRun, Executions } from "~/lib/executions";
import { DEFAULT_QUEUE } from "~/lib/executions";
import { errorCode } from "~/lib/observations";
import type { TaskContext, TaskDefinition } from "~/lib/tasks";
import type { Agents, SandboxHandle } from "~/lib/types";

/**
 * Launches: every run from the moment it is launched until it settles. The
 * launcher records it queued, lets its queue admit it, runs a host task's
 * body here or hands a workflow to the engine to dispatch, records how it
 * ends, and hands its caller the value. It holds what is owed to callers
 * and what runs here now; everything about following a workflow through
 * the Orchestrator stays with the engine, behind {@link WorkflowDispatch}.
 */

export interface LaunchOptions {
  /** Host identifiers recorded on the run, such as `moduleId` or `agentSessionId`. */
  readonly correlation?: Readonly<Record<string, string>>;
  /** The queue to wait in; the task's own, or `marbles`, by default. */
  readonly queue?: string;
  /**
   * Whether a failure's message goes on the run's record beside its safe
   * code; on by default. Turn it off for work whose errors may quote what
   * was sent (a provider's reply): the record keeps the code, and the
   * caller's `result` still rejects with the error itself. A run let in
   * again after a restart has no caller, and records its message.
   */
  readonly recordErrorMessage?: boolean;
  /**
   * The request's identity: launching the same name with it again returns
   * the run it started, for as long as that run is retained.
   */
  readonly source?: string;
  /** The trigger that started it, recorded on the run. */
  readonly triggerId?: string;
}

/** A launched run: its id now, its value once it settles. */
export interface Launched<O> {
  readonly id: string;
  readonly result: Promise<O>;
}

/** A workflow run the engine has dispatched, or adopted, and follows to its end. */
export interface DispatchedRun {
  /** Cancel it through the Orchestrator. */
  cancel(): Promise<void>;
  /**
   * How a rejected `result` ended the run: `undefined` when it has not
   * ended, such as a run left parked when the engine stops.
   */
  endedAs(): "cancelled" | "failed" | undefined;
  /** Its value, once it is followed to its end. */
  readonly result: Promise<unknown>;
}

/** The engine's side of a workflow run: the one way the launcher reaches the Orchestrator. */
interface WorkflowDispatch {
  /** Cancel a Run the Orchestrator holds that is not running here. */
  cancel(id: string): Promise<void>;
  /**
   * Dispatch the run under its own id, and follow it. An abort of `signal`
   * before the Orchestrator takes the run withdraws it, and this rejects.
   */
  dispatch(
    run: ExecutionRun,
    input: unknown,
    signal: AbortSignal
  ): Promise<DispatchedRun>;
  /** Whether a workflow by this name can run. */
  has(name: string): boolean;
}

/** What a task run's agent sessions belong to. */
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
  /** Sessions for a task run: they stop with it, close when it settles, and record on it. */
  readonly agents: (run: TaskRunSite) => Agents;
  readonly executions: Executions;
  readonly print: (line: string) => void;
  /** Whether queued runs an exited process left are let in again at start. */
  readonly recoverQueued: boolean;
  /** Lend a task run a container the host owns; exec through it stops with the run. */
  readonly sandbox: (
    container: Container,
    signal: AbortSignal
  ) => SandboxHandle;
  readonly workflows: WorkflowDispatch;
}

/** A run's value, owed to whoever launched it until it settles. */
interface Owed extends PromiseWithResolvers<unknown> {
  readonly recordErrorMessage: boolean;
}

/** A run admitted here, from its start until it settles. */
type Live =
  | {
      /** Withdraws a dispatch in flight; absent for an adopted run. */
      readonly controller?: AbortController;
      readonly kind: "workflow";
      /**
       * Its dispatch; `undefined` when dispatching failed or was withdrawn,
       * given only once the record is settled.
       */
      readonly dispatched: Promise<DispatchedRun | undefined>;
    }
  | {
      readonly controller: AbortController;
      /** Settles once the run is recorded settled. */
      done: Promise<void>;
      readonly kind: "task";
      /** It gave up its slot, so only a stop ends it. */
      released: boolean;
    };

type Ending = "cancelled" | "failed" | undefined;

/**
 * A run its queue has let in or is about to, until it settles: its abort
 * controller exists before any lifecycle update is published, so a cancel
 * a subscriber sends from that update reaches it before its body starts.
 */
interface Admission {
  readonly controller: AbortController;
  /** Resolves once its caller has been paid: the run has settled here. */
  readonly settled: PromiseWithResolvers<void>;
}

/** How a stop in progress treats what is still running: absent until one begins. */
type Halting = "stop" | "cancel" | undefined;

export class Launcher {
  readonly executions: Executions;
  readonly #options: LauncherOptions;
  readonly #tasks = new Map<string, TaskDefinition>();
  readonly #owed = new Map<string, Owed>();
  readonly #live = new Map<string, Live>();
  readonly #admitted = new Map<string, Admission>();
  /**
   * Set when a stop begins and kept: the engine never starts again. A task
   * that gives up its slot from then on is stopped at once, and one that
   * starts while a cancelling stop runs never gets to its body.
   */
  #halting: Halting;

  constructor(options: LauncherOptions) {
    this.#options = options;
    this.executions = options.executions;
  }

  /** Whether a task has this name. */
  has(name: string): boolean {
    return this.#tasks.has(name);
  }

  /** Add a host task; the engine has checked its name. */
  task(definition: TaskDefinition): void {
    this.#tasks.set(definition.name, definition);
  }

  /** Whether anything here can run this name: a task or a workflow. */
  #runnable(name: string): boolean {
    return this.#tasks.has(name) || this.#options.workflows.has(name);
  }

  /** Whether what is registered under the run's name is the kind it was launched as. */
  #runnableAs(run: Pick<ExecutionRun, "kind" | "name">): boolean {
    return run.kind === "task"
      ? this.#tasks.has(run.name)
      : this.#options.workflows.has(run.name);
  }

  /**
   * Record a run queued and let its queue admit it. When the queue lets it
   * in at once, it has also started when this resolves, so a bad input
   * still rejects here. A `source` already launched under this name returns
   * that run: its value when it is running here, `undefined` once it
   * completed, else the reason it did not.
   */
  async launch<O>(
    name: string,
    input: unknown,
    options: LaunchOptions
  ): Promise<Launched<O>> {
    if (!this.#runnable(name)) {
      throw new Error(`Definition is not registered: ${name}`);
    }
    const task = this.#tasks.get(name);
    const { existing, run } = this.executions.enqueue({
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
      return { id: run.id, result: this.#resultOf<O>(run) };
    }
    const owed = this.#owe(run.id, options.recordErrorMessage ?? true);
    // A subscriber told it is queued may have cancelled it already.
    const started = this.#admit(run.id);
    if (started) {
      await started;
    }
    return { id: run.id, result: owed.promise as Promise<O> };
  }

  /** Follow a parked workflow run this process adopted from an earlier one. */
  follow(id: string, dispatched: DispatchedRun): void {
    this.#live.set(id, {
      dispatched: Promise.resolve(dispatched),
      kind: "workflow",
    });
    this.#finish(id, dispatched.result, dispatched.endedAs);
  }

  /**
   * Take over the Execution Runs of processes that have exited: what was
   * running is recorded interrupted, unless its workflow's file says how it
   * ended or that it parked, adopted parked runs stay this process's, and
   * queued runs are let in again in their order when the host asked for
   * that and what is registered under their name is the kind they were
   * launched as.
   */
  recover(options: {
    readonly adopted: ReadonlySet<string>;
    /** What a workflow run's own file says its status is; `undefined` without one. */
    readonly fileStatus: (run: ExecutionRun) => string | undefined;
  }): void {
    const readmitted = this.executions.recover({
      adopted: options.adopted,
      fileStatus: options.fileStatus,
      readmit: (run) => this.#options.recoverQueued && this.#runnableAs(run),
    });
    for (const run of readmitted) {
      this.#options.print(`[run] ${run.name} queued again ${run.id}`);
      this.#owe(run.id, true);
      this.#admit(run.id);
    }
  }

  /**
   * Cancel one run, wherever it is: off its queue if it is still waiting,
   * aborted if it is a task, and through the Orchestrator otherwise. A run
   * still being dispatched is withdrawn, so its body never starts, or, if
   * the Orchestrator took it first, cancelled there once it is dispatched.
   * A run whose process exited and that no process adopted is recorded
   * cancelled here. A task is settled when this returns; a run that has
   * already settled is left as it is.
   */
  async cancel(id: string): Promise<void> {
    if (this.executions.withdraw(id)) {
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
      // Recorded running, its body not yet started: a subscriber cancelling
      // from that update. Its start sees the abort and runs nothing.
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
    // Its owner exited and nothing adopted it: nothing will settle it but this.
    if (this.executions.cancelOrphan(id)) {
      return;
    }
    if (run?.kind === "task") {
      throw new Error(`run ${id} is not running in this process`);
    }
    await this.#options.workflows.cancel(id);
  }

  /**
   * Withdraw queued work and abort live dispatches and tasks before
   * shutdown awaits anything; from now on, a task that starts here is
   * aborted before its body runs.
   */
  cancelPending(): void {
    this.#halting = "cancel";
    for (const id of this.executions.waiting()) {
      this.executions.withdraw(id);
      this.#pay(id, new Error(`run ${id} was cancelled before it started`));
    }
    for (const [id, live] of this.#live) {
      live.controller?.abort(new Error(`run ${id} stopped with the engine`));
    }
  }

  /**
   * The first half of a stop. When cancelling, every waiting run comes off
   * its queue, every dispatch in flight is withdrawn and every task is
   * aborted at once, before anything is awaited, so a slot freed meanwhile
   * lets nothing in. Otherwise the tasks that cannot outlive the stop,
   * those that gave up their slot, are aborted first, so a factory waiting
   * on what such a task holds is not waited on forever. Then wait for the
   * dispatches in flight. From the start of the stop, a task that gives up
   * its slot is aborted as it does.
   */
  async halt(cancel: boolean): Promise<void> {
    if (cancel) {
      this.cancelPending();
    } else {
      this.#halting ??= "stop";
    }
    this.#abortHalted();
    await Promise.all(
      [...this.#live.values()].map((live) =>
        live.kind === "workflow" ? live.dispatched : undefined
      )
    );
    this.#abortHalted();
  }

  /** Abort each task a stop in progress does not let outlive it. */
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

  /** Resolves once every task running here has settled. */
  async settled(): Promise<void> {
    await Promise.all(
      [...this.#live.values()].map((live) =>
        live.kind === "task" ? live.done : undefined
      )
    );
  }

  #owe(id: string, recordErrorMessage: boolean): Owed {
    const owed: Owed = {
      ...Promise.withResolvers<unknown>(),
      recordErrorMessage,
    };
    // The host may attach later, or never: a recovered run has no caller.
    owed.promise.catch(() => undefined);
    this.#owed.set(id, owed);
    return owed;
  }

  /** Hand the launcher its value, or the reason there is none. */
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

  /** The value of a run launched before, as far as this process knows it. */
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

  /**
   * Wait in the run's queue; the start, when the queue let it in at once.
   * A run no longer queued, cancelled by a subscriber told it was, is paid
   * its cancellation instead.
   */
  #admit(id: string): Promise<void> | undefined {
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
      // Admission may happen when another run frees its queue slot. Keep
      // this launch's request context for its body and output observers.
      AsyncResource.bind((input: unknown) =>
        this.#start(id, input, admission.controller)
      ),
      (error) => this.#pay(id, error)
    );
  }

  /**
   * Let in: a task runs its body, a workflow is dispatched under the run's
   * id. What it was launched as decides which, so a task replaced by a
   * workflow of its name (or the reverse) is never handed the other's input.
   */
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
      this.executions.settle(id, "failed", this.#failure(id, error));
      this.#pay(id, error);
      return Promise.reject(error);
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
    // The dispatch's outcome: the run it became, or nothing, given only once
    // a failed dispatch has settled the record. A cancel or a stop awaiting
    // it therefore reads a settled record, whatever else awaits the dispatch.
    const outcome = Promise.withResolvers<DispatchedRun | undefined>();
    // Held from now, so a cancel or a stop finds it before it is dispatched.
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
        this.executions.settle(run.id, "cancelled");
        this.#pay(run.id, new Error(`run ${run.id} was cancelled`));
        return;
      }
      this.executions.settle(run.id, "failed", this.#failure(run.id, error));
      this.#pay(run.id, error);
      throw error;
    } finally {
      outcome.resolve(dispatched);
    }
    this.#finish(run.id, dispatched.result, dispatched.endedAs);
  }

  /** Run a task's body in the background, and record how it ends. */
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
    // Completion closes resource lifetime without changing cancellation outcome.
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
          // Completing one it began keeps the start it began with.
          { keepStart: observation.startedAt === undefined }
        ),
      progress: (value) => this.executions.progress(id, value),
      release: () => {
        live.released = true;
        this.executions.release(id);
        // A stop has begun: a task that gives up its slot cannot outlive
        // it. Aborted just after this returns, so a body that goes on to
        // wait for its signal is listening when it fires.
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
    const result = (async () => {
      let value: unknown;
      try {
        // Cancelled before its body started: it never runs.
        controller.signal.throwIfAborted();
        value = await task.run(input, context);
      } finally {
        lifetime.abort(new Error(`run ${id} resource lifetime ended`));
        // Last opened first, one at a time, as a run scope closes: a
        // session's turn stops before the sandbox under it goes.
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
    })();
    live.done = this.#finish(id, result, () =>
      controller.signal.aborted ? "cancelled" : "failed"
    );
  }

  /** Record how a run ended, once `result` settles, and pay its caller. */
  #finish(
    id: string,
    result: Promise<unknown>,
    endedAs: (error: unknown) => Ending
  ): Promise<void> {
    return result.then(
      (value) => {
        this.#live.delete(id);
        this.executions.settle(id, "complete");
        this.#pay(id, undefined, value);
      },
      (error: unknown) => {
        this.#live.delete(id);
        const ending = endedAs(error);
        if (ending === "cancelled") {
          this.executions.settle(id, "cancelled");
        } else if (ending === "failed") {
          this.executions.settle(id, "failed", this.#failure(id, error));
        }
        this.#pay(id, error);
      }
    );
  }

  /** What a failed run records: its safe code, and its message unless its launch said not to. */
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
