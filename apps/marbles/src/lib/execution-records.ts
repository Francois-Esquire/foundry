import { randomUUID } from "node:crypto";
import { processAlive } from "@foundry/lib/file-lock";
import type { JsonValue } from "@foundry/lib/json";
import { canonicalizeJson } from "@foundry/lib/json";
import {
  bySequence,
  DEFAULT_QUEUE,
  type EnqueueInput,
  type ExecutionObservation,
  type ExecutionRun,
  type ExecutionSubscription,
  indexOf,
  jsonInput,
  nextRevision,
  now,
  parseStored,
  type RetentionGap,
  withObservation,
} from "./execution-record";
import { SETTLED_EXECUTION_STATUSES } from "./execution-statuses";
import type {
  ExecutionStore,
  ExecutionView,
  StoredExecution,
} from "./execution-store";
import type { RunStore } from "./run-store";
import { ANY_STORED_RUN } from "./run-store";

/** Unsettled, and this process's to settle. */
function ownedHere(run: ExecutionRun): boolean {
  return (
    run.owner.pid === process.pid && !SETTLED_EXECUTION_STATUSES.has(run.status)
  );
}

/** Another process that has exited; this process is never one. */
function exited(pid: number): boolean {
  return pid !== process.pid && !processAlive(pid);
}

/** How a settled run ends. */
type Ending = "complete" | "failed" | "cancelled" | "interrupted";

/** `run` settled as `status`: its input goes, and it is never changed again. */
function settledAs(
  run: ExecutionRun,
  status: Ending,
  error?: { readonly code: string; readonly message?: string }
): ExecutionRun {
  const at = now();
  const { input: _input, ...rest } = run;
  return {
    ...rest,
    ...(error === undefined ? {} : { error }),
    revision: run.revision + 1,
    status,
    timestamps: { ...run.timestamps, settledAt: at, updatedAt: at },
  };
}

const INTERRUPTED = {
  code: "interrupted",
  message: "its process exited while it was running",
} as const;

/** Storage and cleanup owned by the durable execution authority. */
export interface ExecutionRecordsOptions {
  /**
   * Told of each settled run being pruned, before its record goes, to
   * drop what else it kept. One that rejects keeps the record, so pruning
   * it again retries.
   */
  readonly removed?: (run: ExecutionRun) => Promise<void> | void;
  /**
   * Where workflow Runs are kept, whose claim on a Run a cancelled orphan
   * takes so no adopter takes it at the same time. Without it, nothing
   * else can own a workflow's Run.
   */
  readonly runs?: Pick<RunStore, "claim" | "release">;
  readonly store: ExecutionStore;
  readonly warn: (line: string) => void;
}

/**
 * Canonical execution records: persistence, observations, snapshots,
 * retention and owner recovery.
 *
 * This process's own view (`get`, `list`) changes at once with each
 * change it makes, and every write it makes to the store lands in the
 * order it was made, one at a time. A write the domain needs on disk
 * before it goes on (a run queued before anything admits it, running
 * before its first effect, taken over before it is let in again) is
 * awaited, and its failure is the caller's; any other change (progress,
 * an observation, a park, a settle) is published at once, written in its
 * turn, and warned of when the write fails. `flush` waits for every write
 * made so far. A step that reads, decides and writes across processes
 * (launching a source, cancelling an orphan, taking one over, pruning) is
 * one store transaction.
 */
export class ExecutionRecords {
  readonly #store: ExecutionStore;
  readonly #warn: (line: string) => void;
  readonly #records = new Map<string, ExecutionRun>();
  readonly #listeners = new Set<(run: ExecutionRun) => void>();
  readonly #removed: (run: ExecutionRun) => Promise<void> | void;
  readonly #runs: Pick<RunStore, "claim" | "release"> | undefined;
  /** Each record's observation positions by id, for the array it was built for. */
  readonly #indexes = new WeakMap<
    readonly ExecutionObservation[],
    Map<string, number>
  >();
  #gaps = new Map<string, RetentionGap>();
  #sequence = 0;
  /** The last write made, after which the next one starts. */
  #writes: Promise<unknown> = Promise.resolve();
  /** Settlements whose write failed, by run id, to try again. */
  readonly #unsettled = new Map<
    string,
    {
      readonly error?: { readonly code: string; readonly message?: string };
      readonly status: Ending;
    }
  >();

  constructor(options: ExecutionRecordsOptions) {
    this.#store = options.store;
    this.#warn = options.warn;
    this.#removed = options.removed ?? (() => undefined);
    this.#runs = options.runs;
  }

  /** Resolves once every write made so far has landed or failed. */
  async flush(): Promise<void> {
    await this.#writes;
  }

  gaps(): readonly RetentionGap[] {
    return [...this.#gaps.values()];
  }

  get(id: string): ExecutionRun | undefined {
    return this.#records.get(id);
  }

  list(): readonly ExecutionRun[] {
    return [...this.#records.values()].sort(bySequence);
  }

  async prune(
    ids: Iterable<string>,
    scopeOf: (run: ExecutionRun) => string
  ): Promise<readonly ExecutionRun[]> {
    const candidates = [...new Set(ids)].flatMap((id) => {
      const run = this.#records.get(id);
      return run && SETTLED_EXECUTION_STATUSES.has(run.status) ? [run] : [];
    });
    // Decided on the stored record, never on what this process last saw:
    // only one stored settled is cleaned up, and a settled record never
    // changes again, so it is still settled when it is removed (checked
    // once more in the removal's own transaction). Failed cleanup leaves
    // its record for a retry and is not a removal; a run another process
    // pruned already is not cleaned up again.
    const cleaned: ExecutionRun[] = [];
    for (const candidate of candidates) {
      const run = this.#parse(await this.#store.get(candidate.id));
      if (run === undefined) {
        this.#records.delete(candidate.id);
        continue;
      }
      if (!SETTLED_EXECUTION_STATUSES.has(run.status)) {
        this.#learn(run);
        continue;
      }
      try {
        await this.#removed(run);
        cleaned.push(run);
      } catch (error) {
        this.#warn(`[state] run ${run.id} not removed: ${String(error)}`);
      }
    }
    if (cleaned.length === 0) {
      return [];
    }
    const { gaps, removed } = await this.#persist(() =>
      this.#store.transaction((view) =>
        removing(view, cleaned, scopeOf, (stored) => this.#parse(stored))
      )
    );
    this.#gaps = gaps;
    for (const run of removed) {
      this.#records.delete(run.id);
    }
    return removed;
  }

  async subscribe(
    listener: (run: ExecutionRun) => void
  ): Promise<ExecutionSubscription> {
    this.#listeners.add(listener);
    await this.#refresh();
    return {
      snapshot: this.list(),
      unsubscribe: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  /**
   * Read what the store retains; an unreadable record is skipped with a
   * warning, and so is an observation that is not one. A store that cannot
   * be read rejects.
   */
  async load(): Promise<void> {
    this.#gaps = gapsOf(await this.#store.gaps());
    for (const run of await this.#stored()) {
      this.#records.set(run.id, run);
      this.#sequence = Math.max(this.#sequence, run.sequence);
    }
  }

  /** Every readable run in the store. */
  async #stored(): Promise<ExecutionRun[]> {
    const runs: ExecutionRun[] = [];
    for (const stored of await this.#store.list()) {
      const run = this.#parse(stored);
      if (run === undefined) {
        this.#warn(
          `[state] skipped executions/${stored.id}: not an execution run`
        );
        continue;
      }
      runs.push(run);
    }
    return runs;
  }

  /** A stored run, warning of each observation of it that is not one. */
  #parse(stored: StoredExecution | undefined): ExecutionRun | undefined {
    return (
      stored &&
      parseStored(stored, (count) =>
        this.#warn(
          `[state] skipped ${String(count)} unreadable observation(s) in executions/${stored.id}`
        )
      )
    );
  }

  /**
   * Take in what other processes sharing the store wrote since this one
   * read it: a record they changed (a higher revision) and one they
   * pruned. A run this process owns and has not settled stays while the
   * store lacks it.
   */
  async #refresh(): Promise<void> {
    let stored: ExecutionRun[];
    let gaps: readonly RetentionGap[];
    try {
      stored = await this.#stored();
      gaps = await this.#store.gaps();
    } catch (error) {
      this.#warn(`[state] executions not refreshed: ${String(error)}`);
      return;
    }
    this.#gaps = gapsOf(gaps);
    const seen = new Set<string>();
    for (const run of stored) {
      seen.add(run.id);
      this.#sequence = Math.max(this.#sequence, run.sequence);
      const local = this.#records.get(run.id);
      if (local && local.revision >= run.revision) {
        continue;
      }
      this.#records.set(run.id, run);
    }
    for (const [id, local] of this.#records) {
      if (!(seen.has(id) || ownedHere(local))) {
        this.#records.delete(id);
      }
    }
  }

  /**
   * Record a run as queued, durably, before anything admits it. A source
   * that already has a retained run under the same name returns that run
   * instead, whichever engine sharing the store launched it: the look and
   * the write are one transaction. Rejects when the record cannot be
   * written: a run that is not recorded does not exist.
   */
  async enqueue(request: EnqueueInput): Promise<{
    readonly existing: boolean;
    readonly run: ExecutionRun;
  }> {
    // Before anything is recorded: an input that is not JSON never queues.
    const input =
      request.input === undefined ? undefined : jsonInput(request.input);
    const { source } = request;
    if (source === undefined) {
      const run = this.#queued(request, input);
      await this.#put(run);
      this.#publish(run);
      return { existing: false, run };
    }
    const launched = await this.#persist(() =>
      this.#store.transaction(async (view) => {
        const stored = this.#parse(await view.withSource(request.name, source));
        if (stored) {
          return { existing: true, run: stored };
        }
        const run = this.#queued(request, input);
        if (!(await view.put(run))) {
          throw new Error(`execution run ${run.id} is stored already`);
        }
        return { existing: false, run };
      })
    );
    if (launched.existing) {
      this.#learn(launched.run);
      this.#sequence = Math.max(this.#sequence, launched.run.sequence);
    } else {
      this.#publish(launched.run);
    }
    return launched;
  }

  /** A new run, queued and owned by this process, not yet recorded. */
  #queued(request: EnqueueInput, input: JsonValue | undefined): ExecutionRun {
    this.#sequence = Math.max(Date.now(), this.#sequence + 1);
    const at = now();
    return {
      correlation: { ...request.correlation },
      id: `rn-${randomUUID()}`,
      ...(input === undefined ? {} : { input }),
      kind: request.kind,
      name: request.name,
      observations: [],
      owner: { pid: process.pid },
      queue: request.queue,
      revision: 1,
      sequence: this.#sequence,
      ...(request.source === undefined ? {} : { source: request.source }),
      status: "queued",
      timestamps: { queuedAt: at, updatedAt: at },
    };
  }

  progress(id: string, value: JsonValue): void {
    this.changeRecord(id, { progress: value });
  }

  /**
   * Record or replace an observation by id, at the same cost however many
   * the run has. Resolves true once it is durably recorded; false for an
   * unknown or settled run, or a failed write (the change still holds in
   * this process). `keepStart` says the observation's `startedAt` was not
   * given: replacing one keeps the start it was first recorded with.
   */
  observe(
    id: string,
    observation: ExecutionObservation,
    options?: { readonly keepStart?: boolean }
  ): Promise<boolean> {
    const run = this.#records.get(id);
    if (!run || SETTLED_EXECUTION_STATUSES.has(run.status)) {
      return Promise.resolve(false);
    }
    const index =
      this.#indexes.get(run.observations) ?? indexOf(run.observations);
    const observations = withObservation(
      run.observations,
      index,
      observation,
      options?.keepStart ?? false
    );
    this.#indexes.set(observations, index);
    const changed = nextRevision(run, { observations });
    const recorded = observations.at(-1) ?? observation;
    this.#publish(changed);
    return this.#persist(() =>
      this.#store.observe(id, recorded, {
        revision: changed.revision,
        updatedAt: changed.timestamps.updatedAt,
      })
    ).catch((error: unknown) => {
      this.#warn(
        `[state] execution ${id} observation not saved: ${String(error)}`
      );
      return false;
    });
  }

  /**
   * Record a parked workflow run adopted from a Run that has no Execution
   * Run, one parked before they existed, so it is listed, records its
   * progress, and can be pruned once it settles. Nothing for a run
   * already recorded. `createdAt` (ms) orders it among the others.
   */
  async adoptParked(run: {
    readonly createdAt: number;
    readonly id: string;
    readonly name: string;
  }): Promise<void> {
    if (this.#records.has(run.id)) {
      return;
    }
    const at = Number.isFinite(run.createdAt)
      ? new Date(run.createdAt).toISOString()
      : now();
    const sequence = Number.isFinite(run.createdAt)
      ? run.createdAt
      : this.#sequence + 1;
    this.#sequence = Math.max(this.#sequence, sequence);
    await this.#land({
      correlation: {},
      id: run.id,
      kind: "workflow",
      name: run.name,
      observations: [],
      owner: { pid: process.pid },
      queue: DEFAULT_QUEUE,
      revision: 1,
      sequence,
      status: "suspended",
      timestamps: { queuedAt: at, startedAt: at, updatedAt: now() },
    });
  }

  /**
   * Record cancelled a queued run that has not started, decided on the
   * stored record in the transaction that settles it: one stored queued,
   * whose owner is this process or one that has exited. `false`, changing
   * nothing, otherwise: it started, settled, or a live process owns it,
   * and this process then holds what is stored. Rejects when the store
   * cannot be read or written, cancelling nothing.
   */
  protected async cancelQueued(id: string): Promise<boolean> {
    const { cancelled, run } = await this.#persist(() =>
      this.#store.transaction(async (view) => {
        const stored = this.#parse(await view.get(id));
        if (
          stored?.status !== "queued" ||
          !(stored.owner.pid === process.pid || exited(stored.owner.pid))
        ) {
          return { cancelled: false, run: stored };
        }
        const settled = settledAs(
          stored.owner.pid === process.pid
            ? stored
            : nextRevision(stored, { owner: { pid: process.pid } }),
          "cancelled"
        );
        return { cancelled: await view.put(settled), run: settled };
      })
    );
    if (run) {
      this.#learn(run);
    }
    return cancelled;
  }

  /**
   * What a workflow Run of this process's committing as `status` makes of
   * its Execution Run, for the run store to write in the same commit
   * (`RunFollower`): a park makes it suspended and a resume running again,
   * so a crash never leaves one without the other. Nothing for any other
   * status: a settle carries what the Run does not (the failure as its
   * launch records it), so the launcher writes it, and a crash between is
   * repaired from the Run's status (`recover`). The change is published
   * here at once, so every later change builds on it and none is written
   * over it; the park or resume that follows writes it to this engine's
   * own store, where the Run's commit has written it already when the two
   * share a database. Should the Run's commit fail, this process says the
   * run parked or resumed until its next change.
   */
  follows(runId: string, status: string): ExecutionRun | undefined {
    const run = this.#records.get(runId);
    if (!(run && run.kind === "workflow" && ownedHere(run))) {
      return;
    }
    const next =
      (status === "suspended" && run.status === "running") ||
      (status === "running" && run.status === "suspended")
        ? nextRevision(run, { status })
        : undefined;
    if (next) {
      this.#publish(next);
    }
    return next;
  }

  /** Whether the store holds the run's record settled, read afresh. */
  async storedSettled(id: string): Promise<boolean> {
    const run = this.#parse(await this.#store.get(id));
    return run !== undefined && SETTLED_EXECUTION_STATUSES.has(run.status);
  }

  /**
   * Record cancelled an unsettled run whose owner has exited and that no
   * process has adopted; `false`, changing nothing, otherwise. For a
   * workflow it first takes the claim on its Run that an adopter takes
   * before it reads the record and keeps for as long as it owns the run;
   * then, in one transaction, it reads the record and its owner again and
   * settles it. The claim is given up once the record is settled. The
   * parked Run stays in the run store until the run is pruned; a process
   * that would adopt it finds the record settled under its claim and
   * leaves it (see {@link storedSettled}).
   */
  async cancelOrphan(id: string): Promise<boolean> {
    const known = this.#records.get(id);
    if (
      !known ||
      SETTLED_EXECUTION_STATUSES.has(known.status) ||
      !exited(known.owner.pid)
    ) {
      return false;
    }
    const runs = known.kind === "workflow" ? this.#runs : undefined;
    // Ownership is all the claim decides: the record is read again in the
    // execution store's transaction below, which every recoverer takes too.
    if (runs && !(await runs.claim(id, ANY_STORED_RUN))) {
      return false;
    }
    try {
      const { cancelled, run } = await this.#persist(() =>
        this.#store.transaction(async (view) => {
          const stored = this.#parse(await view.get(id));
          if (
            !stored ||
            SETTLED_EXECUTION_STATUSES.has(stored.status) ||
            !exited(stored.owner.pid)
          ) {
            return { cancelled: false, run: stored };
          }
          const settled = settledAs(
            nextRevision(stored, { owner: { pid: process.pid } }),
            "cancelled"
          );
          return { cancelled: await view.put(settled), run: settled };
        })
      );
      if (run) {
        // What is stored: an adopter may own it now.
        this.#learn(run);
      }
      return cancelled;
    } finally {
      await runs?.release(id);
    }
  }

  /**
   * Take over the unsettled runs of processes that have exited, each in a
   * transaction that reads it afresh, so two engines never take one run.
   * Running work is recorded `interrupted`. A parked run this engine
   * adopted is now its own, and suspended. A queued run `readmit` accepts
   * is now its own, once that is on disk, and is returned, in admission
   * order, for the caller to admit; any other is left queued for a process
   * that can run it.
   *
   * A workflow's own Run can be ahead of its record, committed just before
   * its process exited: one that settled settles the record the same way;
   * one parked leaves the record suspended for a process to adopt; one
   * resumed and running again was mid-flight, so the record is interrupted.
   * A suspended record without a Run is left for adoption.
   */
  async recover(options: {
    readonly adopted: ReadonlySet<string>;
    /** What a workflow run's own Run says its status is; `undefined` without one. */
    readonly fileStatus?: (run: ExecutionRun) => string | undefined;
    readonly readmit: (run: ExecutionRun) => boolean;
  }): Promise<readonly ExecutionRun[]> {
    const readmitted: ExecutionRun[] = [];
    const orphans = this.list().filter(
      (run) =>
        !SETTLED_EXECUTION_STATUSES.has(run.status) &&
        (options.adopted.has(run.id) || exited(run.owner.pid))
    );
    for (const orphan of orphans) {
      let taken: { readonly next?: ExecutionRun; readonly readmit: boolean };
      try {
        taken = await this.#persist(() =>
          this.#store.transaction(async (view) => {
            const run = this.#parse(await view.get(orphan.id));
            const next = run && recovered(run, options);
            if (!(run && next)) {
              return { readmit: false };
            }
            const kept = await view.put(next.run);
            return { next: next.run, readmit: kept && next.readmit };
          })
        );
      } catch (error) {
        this.#warn(
          `[state] execution ${orphan.id} not taken over, left as it was: ${String(error)}`
        );
        continue;
      }
      if (taken.next) {
        this.#publish(taken.next);
        if (taken.readmit) {
          readmitted.push(taken.next);
        }
      }
    }
    return readmitted.sort(bySequence);
  }

  /**
   * Write what this process holds of a known, unsettled run, in its turn;
   * a failed write warns. For a change already published (`follows`).
   */
  protected keepRecord(id: string): void {
    const run = this.#records.get(id);
    if (run && !SETTLED_EXECUTION_STATUSES.has(run.status)) {
      this.#put(run).catch((error: unknown) => {
        this.#warn(`[state] execution ${id} not saved: ${String(error)}`);
      });
    }
  }

  /**
   * Apply a change to a known, unsettled run, at once here and on disk in
   * its turn; a failed write warns and the change still holds here. A
   * settled run never changes.
   */
  protected changeRecord(
    id: string,
    patch: Partial<Omit<ExecutionRun, "id" | "revision">>
  ): ExecutionRun | undefined {
    const run = this.#records.get(id);
    if (!run || SETTLED_EXECUTION_STATUSES.has(run.status)) {
      return undefined;
    }
    const changed = nextRevision(run, patch);
    this.#commit(changed);
    return changed;
  }

  /**
   * Publish now, and write in its turn: resolves whether it was written;
   * a failed write warns. Only for an advisory change (progress, a park or
   * resume), which nothing acknowledges and on which nothing is cancelled,
   * launched or removed; one the store refuses as stale leaves this
   * process holding what is stored (`#put`).
   */
  #commit(run: ExecutionRun): Promise<boolean> {
    this.#publish(run);
    return this.#put(run).then(
      () => true,
      (error: unknown) => {
        this.#warn(`[state] execution ${run.id} not saved: ${String(error)}`);
        return false;
      }
    );
  }

  /**
   * Write in its turn, and publish once it is written: rejects, publishing
   * nothing, when the store refuses the write, which the caller handles.
   */
  protected async writeRecord(run: ExecutionRun): Promise<void> {
    await this.#land(run);
  }

  /** Write `run` in its turn, then publish it; rejects, publishing nothing, when it is not kept. */
  async #land(run: ExecutionRun): Promise<void> {
    await this.#put(run);
    this.#publish(run);
  }

  /**
   * Write `run` in its turn. One the store refuses for a revision as high
   * is landed already when this process has changed the run since (a
   * later write carries it) or what is stored says the same (a Run's
   * commit wrote it, `follows`). Otherwise another write took the run:
   * this process holds what is stored from now on, and this rejects with
   * a `StaleWriteError` carrying it. Nothing is ever written over a
   * revision this process did not make.
   */
  async #put(run: ExecutionRun): Promise<void> {
    await this.#persist(async () => {
      if (await this.#store.put(run)) {
        return;
      }
      if ((this.#records.get(run.id)?.revision ?? 0) > run.revision) {
        return;
      }
      const stored = this.#parse(await this.#store.get(run.id));
      if (stored && sameRecord(stored, run)) {
        return;
      }
      if (stored) {
        this.#learn(stored);
      }
      throw new StaleWriteError(run.id, stored);
    });
  }

  /**
   * Hold `stored`, what the store holds of a run, unless this process
   * holds a later revision: at the same revision the store's is the one
   * that landed.
   */
  #learn(stored: ExecutionRun): void {
    const local = this.#records.get(stored.id);
    if (!local || stored.revision >= local.revision) {
      this.#publish(stored);
    }
  }

  /** `write`, once every write made before it has landed or failed. */
  #persist<T>(write: () => Promise<T>): Promise<T> {
    const landing = this.#writes.then(write);
    this.#writes = landing.catch(() => undefined);
    return landing;
  }

  #publish(run: ExecutionRun): void {
    this.#records.set(run.id, run);
    for (const listener of this.#listeners) {
      try {
        listener(run);
      } catch (error) {
        this.#warn(`[executions] a subscriber failed: ${String(error)}`);
      }
    }
  }

  /**
   * Record how a run ended, on disk in its turn, and only then here:
   * resolves once it is stored. One the store holds settled already, by
   * whatever settled it, resolves too, and this process holds what is
   * stored. When the write fails this rejects, the run is not settled
   * here, and the settlement is kept to try again: at the next settle
   * this process makes, and at `retrySettlements`.
   */
  async settle(
    id: string,
    status: Ending,
    error?: { readonly code: string; readonly message?: string }
  ): Promise<void> {
    this.#unsettled.delete(id);
    this.#retryUnsettled();
    await this.#settleNow(id, status, error);
  }

  /** `settle`, without trying the others again. */
  async #settleNow(
    id: string,
    status: Ending,
    error?: { readonly code: string; readonly message?: string }
  ): Promise<void> {
    const run = this.#records.get(id);
    if (!run || SETTLED_EXECUTION_STATUSES.has(run.status)) {
      return;
    }
    try {
      await this.#land(settledAs(run, status, error));
    } catch (failure) {
      if (
        failure instanceof StaleWriteError &&
        failure.stored &&
        SETTLED_EXECUTION_STATUSES.has(failure.stored.status)
      ) {
        return;
      }
      if (!(failure instanceof StaleWriteError)) {
        this.#unsettled.set(id, { error, status });
      }
      throw failure;
    }
  }

  /**
   * Try again every settlement whose write failed: rejects with every
   * failure when any still cannot be written, keeping those to try again.
   */
  async retrySettlements(): Promise<void> {
    const failures: unknown[] = [];
    for (const [id, { error, status }] of [...this.#unsettled]) {
      this.#unsettled.delete(id);
      try {
        await this.#settleNow(id, status, error);
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `${String(failures.length)} settlement(s) could not be recorded`
      );
    }
  }

  /** `retrySettlements`, at a settle's opportunity: what still fails stays kept, quietly. */
  #retryUnsettled(): void {
    for (const [id, { error, status }] of [...this.#unsettled]) {
      this.#unsettled.delete(id);
      this.#settleNow(id, status, error).catch(() => undefined);
    }
  }
}

/**
 * A write the store refused because another write took the run first:
 * `stored` is what it holds now, which this process holds from then on.
 */
class StaleWriteError extends Error {
  override readonly name = "StaleWriteError";
  readonly stored: ExecutionRun | undefined;

  constructor(id: string, stored: ExecutionRun | undefined) {
    super(
      stored === undefined
        ? `execution ${id} is no longer stored`
        : `execution ${id} was changed by another write (revision ${String(stored.revision)}, ${stored.status})`
    );
    this.stored = stored;
  }
}

/** Whether two revisions of a run say the same, whenever each was written. */
function sameRecord(a: ExecutionRun, b: ExecutionRun): boolean {
  const said = ({
    observations: _observations,
    revision: _revision,
    timestamps: { updatedAt: _updatedAt, ...timestamps },
    ...record
  }: ExecutionRun) => canonicalizeJson({ ...record, timestamps });
  return said(a) === said(b);
}

/** The gaps by scope. */
function gapsOf(gaps: readonly RetentionGap[]): Map<string, RetentionGap> {
  return new Map(gaps.map((gap) => [gap.scope, gap]));
}

/**
 * In one transaction: each cleaned run still stored settled counted in
 * its scope's gap, as it is stored, then removed, the gap written first.
 * Another process that pruned a run meanwhile already counted it.
 */
async function removing(
  view: ExecutionView,
  runs: readonly ExecutionRun[],
  scopeOf: (run: ExecutionRun) => string,
  parse: (stored: StoredExecution | undefined) => ExecutionRun | undefined
): Promise<{
  readonly gaps: Map<string, RetentionGap>;
  readonly removed: readonly ExecutionRun[];
}> {
  const gaps = gapsOf(await view.gaps());
  const at = now();
  const removed: ExecutionRun[] = [];
  const changed = new Set<string>();
  for (const cleaned of runs) {
    const run = parse(await view.get(cleaned.id));
    if (!(run && SETTLED_EXECUTION_STATUSES.has(run.status))) {
      continue;
    }
    const scope = scopeOf(run);
    const gap = gaps.get(scope);
    const settled = run.timestamps.settledAt ?? run.timestamps.updatedAt;
    gaps.set(scope, {
      removed: (gap?.removed ?? 0) + 1,
      scope,
      through: gap && gap.through > settled ? gap.through : settled,
      updatedAt: at,
    });
    changed.add(scope);
    removed.push(run);
  }
  for (const scope of changed) {
    const gap = gaps.get(scope);
    if (gap) {
      await view.putGap(gap);
    }
  }
  for (const run of removed) {
    await view.remove(run.id);
  }
  return { gaps, removed };
}

/**
 * What taking over `run`, read afresh, makes of it: `undefined` when it is
 * left as it is, because it settled or a live process owns it; `readmit`
 * when it is a queued run now this process's to admit.
 */
function recovered(
  run: ExecutionRun,
  options: Parameters<ExecutionRecords["recover"]>[0]
): { readonly readmit: boolean; readonly run: ExecutionRun } | undefined {
  const ours = options.adopted.has(run.id);
  if (
    SETTLED_EXECUTION_STATUSES.has(run.status) ||
    !(ours || exited(run.owner.pid))
  ) {
    return;
  }
  const owned = () => nextRevision(run, { owner: { pid: process.pid } });
  if (ours) {
    // Its Run is parked: the record may have missed the park.
    return {
      readmit: false,
      run: nextRevision(run, {
        owner: { pid: process.pid },
        ...(run.status === "running" ? { status: "suspended" } : {}),
      }),
    };
  }
  if (run.status === "queued") {
    return options.readmit(run) ? { readmit: true, run: owned() } : undefined;
  }
  const ending = reconciled(run, options.fileStatus?.(run));
  if (ending === undefined) {
    return;
  }
  if (ending === "suspended") {
    return { readmit: false, run: nextRevision(run, { status: "suspended" }) };
  }
  return {
    readmit: false,
    run: settledAs(
      owned(),
      ending,
      ending === "interrupted" ? INTERRUPTED : undefined
    ),
  };
}

/**
 * How a running or parked run an exited process left ends, as its Run
 * says: settled, parked for a process that can answer it (`suspended`,
 * its ownership left open), or `undefined` when it stays as it is.
 */
function reconciled(
  run: ExecutionRun,
  file: string | undefined
): Ending | "suspended" | undefined {
  if (run.kind === "task") {
    return run.status === "running" ? "interrupted" : undefined;
  }
  if (file === "complete" || file === "failed" || file === "cancelled") {
    return file;
  }
  if (file === "suspended") {
    return run.status === "running" ? "suspended" : undefined;
  }
  // Resumed and running when its process exited, or never parked.
  return file !== undefined || run.status === "running"
    ? "interrupted"
    : undefined;
}
