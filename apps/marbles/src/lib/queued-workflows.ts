import type { Artifacts } from "@foundry/artifacts";
import type { ProcessIdentity } from "@foundry/lib/process-identity";
import type { QueueStoreService } from "@foundry/queue/store";
import type { ChannelMessage } from "@foundry/workflows/channels";
import type { BaseContext } from "@foundry/workflows/executable";
import type { ExecutionRun } from "~/lib/execution-record";
import type { Executions } from "~/lib/executions";
import type { FeedAnswer } from "~/lib/feed/entry";
import type { FeedPublisher } from "~/lib/feed/publish";
import { feedEntry } from "~/lib/feed/publish";
import type { FeedRouter } from "~/lib/feed/route";
import { feedRouter } from "~/lib/feed/route";
import { HeldRuns } from "~/lib/held-runs";
import type { DispatchedRun } from "~/lib/launcher";
import { RunListing } from "~/lib/run-listing";
import type { RunScopes } from "~/lib/run-scope";
import { PAUSE_KIND } from "~/lib/run-scope";
import type { RunFactory } from "~/lib/workflow-queue";
import { WorkflowQueue } from "~/lib/workflow-queue";
import type { RunRecord } from "~/lib/workflow-runs";
import { readRun, readRuns } from "~/lib/workflow-runs";

export interface QueuedWorkflowsOptions {
  readonly askable: boolean;
  readonly durable: boolean;
  readonly executions: Executions;
  readonly feed: FeedPublisher;
  readonly feedEntries: Pick<Artifacts, "get">;
  readonly follow: (runId: string, dispatched: DispatchedRun) => void;
  readonly print: (line: string) => void;
  readonly registered: (name: string) => boolean;
  readonly scopes: RunScopes;
  readonly state: string | undefined;
  readonly store: QueueStoreService;
}

const under = (path: string, wanted: string) =>
  path === wanted || (wanted !== "" && path.startsWith(`${wanted}.`));

export class QueuedWorkflows {
  readonly queue: WorkflowQueue;
  readonly store: QueueStoreService;
  readonly #held: HeldRuns;
  readonly #listing: RunListing;
  readonly #options: QueuedWorkflowsOptions;
  readonly #router: FeedRouter;

  static async open(options: QueuedWorkflowsOptions): Promise<QueuedWorkflows> {
    const opened = new QueuedWorkflows(options);
    if (options.askable) {
      await opened.#askPending();
    }
    await opened.#listing.load();
    return opened;
  }

  private constructor(options: QueuedWorkflowsOptions) {
    const { askable, durable, executions, feed, print, scopes, state, store } =
      options;
    this.#options = options;
    this.store = store;
    this.queue = new WorkflowQueue(store, {
      prepare: (name, runId) => this.#takeUp(name, runId),
      started: (runId, workflow) => this.#held.attempt(runId, workflow),
    });
    this.#router = feedRouter({
      askable,
      durable,
      entry: (entryId) => feedEntry(options.feedEntries, entryId),
      feed,
      print,
      queue: this.queue,
    });
    this.#held = new HeldRuns({
      executions,
      print,
      queue: this.queue,
      router: this.#router,
      scopes,
      state,
    });
    this.#listing = new RunListing(store);
  }

  register<I, O, X extends BaseContext>(
    name: string,
    factory: RunFactory<I, O, X>
  ): void {
    this.queue.register(name, factory);
  }

  async dispatch(
    run: ExecutionRun,
    input: unknown,
    signal: AbortSignal,
    parentRunId: string | undefined
  ): Promise<DispatchedRun> {
    const { correlation } = run;
    const tracked = this.#held.track(run.name, run.id);
    try {
      await this.queue.run(run.name, input, {
        ...(parentRunId === undefined ? {} : { parentRunId }),
        runId: run.id,
        signal,
        ...("triggerId" in correlation
          ? { triggerId: correlation.triggerId }
          : {}),
      });
    } catch (error) {
      tracked.drop();
      await this.#options.scopes.settle(run.id);
      throw error;
    }
    this.#listing.add(run.id);
    return tracked.start();
  }

  async resume(runId: string, stepId: string, prompt?: string): Promise<void> {
    const pending = await this.queue.suspensions({ kind: PAUSE_KIND, runId });
    const below = stepId.split(".").slice(1).join(".");
    const suspended = pending.filter(
      (item) =>
        under(item.stepPath.join("."), stepId) ||
        under(item.stepPath.slice(1).join("."), below)
    );
    if (suspended.length === 0) {
      throw new Error(`"${stepId}" is not paused`);
    }
    const trimmed = prompt?.trim() || null;
    for (const suspension of suspended) {
      await this.queue.resolve(
        suspension.id,
        { prompt: trimmed },
        { expectedRevision: suspension.revision }
      );
    }
  }

  async cancel(runId: string): Promise<void> {
    const cancelRun = () => this.queue.cancelRun(runId);
    const record = await readRun(this.store, runId).catch(() => null);
    if (record?.status !== "suspended") {
      await cancelRun();
      return;
    }
    await this.#router.cancelWith(record.step, runId, cancelRun);
  }

  answer(entryId: string, answer: FeedAnswer): Promise<void> {
    return this.#router.answer(entryId, answer);
  }

  following(runId: string): boolean {
    return this.#held.has(runId);
  }

  listed(runId: string): void {
    this.#listing.add(runId);
  }

  unlisted(runId: string): void {
    this.#listing.remove(runId);
  }

  async records(): Promise<readonly RunRecord[]> {
    return (await this.#listing.list()).map((record) => this.#asHeld(record));
  }

  async record(runId: string): Promise<RunRecord | undefined> {
    const record = await readRun(this.store, runId);
    return record ? this.#asHeld(record) : undefined;
  }

  stream(
    runId: string,
    signal?: AbortSignal
  ): ReadableStream<ChannelMessage> | undefined {
    return this.#held.workflow(runId)?.root.subscribe(signal);
  }

  retire(successor: ProcessIdentity): Promise<void> {
    return this.queue.retire(successor);
  }

  async cancelHeld(): Promise<void> {
    const doomed = new Set(
      this.#options.durable
        ? ["queued", "running"]
        : ["queued", "running", "suspended"]
    );
    await Promise.all(
      this.#held.ids().map(async (runId) => {
        const state = await this.queue.stateOf(runId).catch(() => undefined);
        if (state !== undefined && doomed.has(state)) {
          await this.queue.cancelRun(runId);
        }
      })
    );
  }

  async cancelQuestions(): Promise<void> {
    if (!this.#options.durable) {
      await this.#router.cancelOpen();
    }
  }

  async drain(): Promise<void> {
    await this.queue.drain();
  }

  settle(): Promise<void> {
    return this.#held.settle();
  }

  stop(): Promise<void> {
    return this.queue.stop();
  }

  #asHeld(record: RunRecord): RunRecord {
    const current = this.#held.workflow(record.id)?.state;
    if (current === undefined) {
      return record;
    }
    return {
      ...record,
      metadata: { ...record.metadata, workflow: current },
      snapshot: current.tree ?? record.snapshot,
    };
  }

  async #askPending(): Promise<void> {
    for (const run of await readRuns(this.store, ["suspended"])) {
      if (this.#options.registered(run.step)) {
        await this.#router
          .publishPending(run.step, run.id)
          .catch((error: unknown) =>
            this.#options.print(`[feed] ${run.id}: ${String(error)}`)
          );
      }
    }
  }

  async #takeUp(name: string, runId: string): Promise<void> {
    const { executions, follow, print } = this.#options;
    if (this.#held.has(runId)) {
      return;
    }
    if (!(await executions.takeUp(runId)) || this.#held.has(runId)) {
      return;
    }
    this.#listing.add(runId);
    follow(runId, this.#held.track(name, runId).start());
    print(`[run] ${name} taken up ${runId}`);
  }
}
