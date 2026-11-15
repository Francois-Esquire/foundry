import { randomUUID } from "node:crypto";
import type { JsonValue } from "@foundry/lib/json";
import {
  isGone,
  type ProcessIdentity,
  sameProcess,
  thisProcess,
} from "@foundry/lib/process-identity";
import {
  bySequence,
  DEFAULT_QUEUE,
  type EnqueueInput,
  type ExecutionObservation,
  type ExecutionRun,
  type ExecutionSubscription,
  indexOf,
  jsonInput,
  now,
  parseStored,
  type RetentionGap,
  withObservation,
} from "./execution-record";
import type { ExecutionStatus } from "./execution-statuses";
import {
  EXECUTION_STATUSES,
  SETTLED_EXECUTION_STATUSES,
} from "./execution-statuses";
import type {
  ExecutionStore,
  ExecutionView,
  LifecycleChange,
  StoredExecution,
  Written,
} from "./execution-store";
import type { RunStore } from "./run-store";
import { ANY_STORED_RUN } from "./run-store";

/** Unsettled, and this process's to settle. */
function ownedHere(run: ExecutionRun): boolean {
  return (
    sameProcess(run.owner, thisProcess()) &&
    !SETTLED_EXECUTION_STATUSES.has(run.status)
  );
}

/** Whether two records name one owner, start and all, exactly as stored. */
function sameOwner(one: ProcessIdentity, other: ProcessIdentity): boolean {
  return one.pid === other.pid && one.started === other.started;
}

/** How a settled run ends. */
type Ending = "complete" | "failed" | "cancelled" | "interrupted";

interface Failure {
  readonly code: string;
  readonly message?: string;
}

/** Every status a run may still leave. */
const UNSETTLED: readonly ExecutionStatus[] = EXECUTION_STATUSES.filter(
  (status) => !SETTLED_EXECUTION_STATUSES.has(status)
);

/**
 * A settle of a run `owner` owns, as `status`: from any unsettled status,
 * owned from then on by `newOwner` when that is given.
 */
function settling(
  owner: ProcessIdentity,
  status: Ending,
  error?: Failure,
  newOwner?: ProcessIdentity
): LifecycleChange {
  const at = now();
  return {
    dropInput: true,
    ...(error === undefined ? {} : { error }),
    from: UNSETTLED,
    ...(newOwner === undefined ? {} : { newOwner }),
    owner,
    settledAt: at,
    status,
    updatedAt: at,
  };
}

const INTERRUPTED = {
  code: "interrupted",
  message: "its process exited while it was running",
} as const;

/** The first retry of a settlement whose write failed, and the longest wait between retries. */
const RETRY_FIRST_MS = 100;
const RETRY_LONGEST_MS = 30_000;

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
 * Every write this process makes lands in the order it was made, one at a
 * time, each worked out in its turn from what this process holds once the
 * writes before it have landed; this process's view (`get`, `list`) then
 * holds what the store gave back, never what it was asked to write. A
 * lifecycle change (queued, running, parked, settled) is decided by the
 * store on the stored status and owner (`ExecutionStore`); an advisory
 * one (progress, an observation) touches only its own field, and is
 * dropped on a settled run. A write the domain needs before it goes on (a
 * run queued before anything admits it, running before its first effect,
 * settled before its caller is paid) is awaited, and its failure is the
 * caller's; progress, an observation, a park or a resume is warned of
 * when its write fails. A step that reads, decides and writes across
 * processes (launching a source, cancelling, taking over, pruning) is one
 * store transaction.
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
    { readonly error?: Failure; readonly status: Ending }
  >();
  /** The next scheduled retry of `#unsettled`, and how long it waited. */
  readonly #retry: {
    passing: boolean;
    timer?: ReturnType<typeof setTimeout>;
    wait: number;
  } = { passing: false, wait: RETRY_FIRST_MS };

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
      this.#learn(run);
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
    const launched = await this.#persist(() =>
      this.#store.transaction(async (view) => {
        const stored =
          source === undefined
            ? undefined
            : this.#parse(await view.withSource(request.name, source));
        if (stored) {
          return { existing: true, run: stored };
        }
        const run = this.#queued(request, input);
        if (!(await view.create(run))) {
          throw new Error(`execution run ${run.id} is stored already`);
        }
        return { existing: false, run };
      })
    );
    this.#sequence = Math.max(this.#sequence, launched.run.sequence);
    this.#learn(launched.run);
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
      owner: thisProcess(),
      queue: request.queue,
      revision: 1,
      sequence: this.#sequence,
      ...(request.source === undefined ? {} : { source: request.source }),
      status: "queued",
      timestamps: { queuedAt: at, updatedAt: at },
    };
  }

  /**
   * Record where a run has got to, in its turn; dropped for a run that is
   * not known or has settled, here or in the store. A failed write warns.
   */
  progress(id: string, value: JsonValue): void {
    this.#persist(async () => {
      const run = this.#records.get(id);
      if (!run || SETTLED_EXECUTION_STATUSES.has(run.status)) {
        return;
      }
      this.#took(
        id,
        await this.#store.advise(id, { progress: value, updatedAt: now() })
      );
    }).catch((error: unknown) => {
      this.#warn(
        `[state] execution ${id} progress not saved: ${String(error)}`
      );
    });
  }

  /**
   * Record or replace an observation by id, at the same cost however many
   * the run has. Resolves true once it is durably recorded; false for an
   * unknown or settled run, or a failed write, which keeps nothing.
   * `keepStart` says the observation's `startedAt` was not given:
   * replacing one keeps the start it was first recorded with.
   */
  observe(
    id: string,
    observation: ExecutionObservation,
    options?: { readonly keepStart?: boolean }
  ): Promise<boolean> {
    return this.#persist(async () => {
      const run = this.#records.get(id);
      if (!run || SETTLED_EXECUTION_STATUSES.has(run.status)) {
        return false;
      }
      const index =
        this.#indexes.get(run.observations) ?? indexOf(run.observations);
      const observations = withObservation(
        run.observations,
        index,
        observation,
        options?.keepStart ?? false
      );
      const recorded = observations.at(-1) ?? observation;
      const written = await this.#store.observe(id, recorded, now());
      if (written.applied) {
        this.#indexes.set(observations, index);
      }
      this.#took(id, written, written.applied ? observations : undefined);
      return written.applied;
    }).catch((error: unknown) => {
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
   * Rejects, recording nothing, when it cannot be written.
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
    const record: ExecutionRun = {
      correlation: {},
      id: run.id,
      kind: "workflow",
      name: run.name,
      observations: [],
      owner: thisProcess(),
      queue: DEFAULT_QUEUE,
      revision: 1,
      sequence,
      status: "suspended",
      timestamps: { queuedAt: at, startedAt: at, updatedAt: now() },
    };
    if (await this.#persist(() => this.#store.create(record))) {
      this.#learn(record);
    } else {
      this.#learn(this.#parse(await this.#store.get(run.id)));
    }
  }

  /**
   * Record a queued run of this process's running, before its first
   * effect: it starts only from queued, so one cancelled meanwhile, here
   * or by any process, rejects with what is stored and does not start.
   */
  protected async startRecord(id: string): Promise<void> {
    const at = now();
    const written = await this.#persist(() =>
      this.#store.transition(id, {
        dropInput: true,
        from: ["queued"],
        owner: thisProcess(),
        startedAt: at,
        status: "running",
        updatedAt: at,
      })
    );
    const stored = this.#took(id, written);
    if (!written.applied) {
      throw new Error(
        `execution run ${id} is ${stored?.status ?? "gone"} now; it does not start`
      );
    }
  }

  /**
   * Record a run of this process's parked (`suspended`) or back at work
   * (`running`), in its turn: a run its Run's commit moved there already
   * (`follows`), or one that left the status it moves from, is left as
   * stored. A failed write warns.
   */
  protected moveRecord(id: string, status: "running" | "suspended"): void {
    const at = now();
    this.#persist(async () =>
      this.#took(
        id,
        await this.#store.transition(id, {
          from: [status === "running" ? "suspended" : "running"],
          owner: thisProcess(),
          status,
          updatedAt: at,
        })
      )
    ).catch((error: unknown) => {
      this.#warn(`[state] execution ${id} not saved: ${String(error)}`);
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
    // Whether its owner is gone is judged before the transaction, which
    // only checks the owner is still the one judged: no process is asked
    // while the store's write lock is held.
    const before = this.#parse(await this.#store.get(id));
    const mayCancel =
      before !== undefined &&
      (sameProcess(before.owner, thisProcess()) || isGone(before.owner));
    const written = await this.#persist(() =>
      this.#store.transaction(async (view): Promise<Written> => {
        const stored = this.#parse(await view.get(id));
        if (
          stored?.status !== "queued" ||
          !mayCancel ||
          !sameOwner(stored.owner, before.owner)
        ) {
          return { applied: false, record: stored };
        }
        return await view.transition(id, {
          ...settling(stored.owner, "cancelled", undefined, thisProcess()),
          from: ["queued"],
        });
      })
    );
    this.#took(id, written);
    return written.applied;
  }

  /**
   * What a workflow Run of this process's committing as `status` makes of
   * its Execution Run, for the run store to make in the same commit
   * (`RunFollower`): a park makes it suspended and a resume running again,
   * so a crash never leaves one without the other. Nothing for any other
   * status: a settle carries what the Run does not (the failure as its
   * launch records it), so the launcher writes it, and a crash between is
   * repaired from the Run's status (`recover`). Changes nothing here: the
   * park or resume itself reads what the store holds then.
   */
  follows(runId: string, status: string): LifecycleChange | undefined {
    const run = this.#records.get(runId);
    if (!(run && run.kind === "workflow" && ownedHere(run))) {
      return;
    }
    const moves =
      (status === "suspended" && run.status === "running") ||
      (status === "running" && run.status === "suspended");
    return moves
      ? {
          from: [run.status],
          owner: thisProcess(),
          status,
          updatedAt: now(),
        }
      : undefined;
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
      !isGone(known.owner)
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
      const written = await this.#persist(() =>
        this.#store.transaction(async (view): Promise<Written> => {
          const stored = this.#parse(await view.get(id));
          // Judged gone above, outside the transaction: still that owner.
          if (
            !stored ||
            SETTLED_EXECUTION_STATUSES.has(stored.status) ||
            !sameOwner(stored.owner, known.owner)
          ) {
            return { applied: false, record: stored };
          }
          return await view.transition(
            id,
            settling(stored.owner, "cancelled", undefined, thisProcess())
          );
        })
      );
      // What is stored: an adopter may own it now.
      this.#took(id, written);
      return written.applied;
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
        (options.adopted.has(run.id) || isGone(run.owner))
    );
    for (const orphan of orphans) {
      let taken: { readonly readmit: boolean; readonly written: Written };
      try {
        taken = await this.#persist(() =>
          this.#store.transaction(async (view) => {
            const run = this.#parse(await view.get(orphan.id));
            // Judged before the transaction; here only checked unchanged.
            const next =
              run &&
              recovered(run, options, sameOwner(run.owner, orphan.owner));
            if (!next) {
              return {
                readmit: false,
                written: { applied: false, record: run },
              };
            }
            const written = await view.transition(orphan.id, next.change);
            return { readmit: written.applied && next.readmit, written };
          })
        );
      } catch (error) {
        this.#warn(
          `[state] execution ${orphan.id} not taken over, left as it was: ${String(error)}`
        );
        continue;
      }
      const stored = this.#took(orphan.id, taken.written);
      if (taken.readmit && stored) {
        readmitted.push(stored);
      }
    }
    return readmitted.sort(bySequence);
  }

  /**
   * Record how a run of this process's ended, on disk in its turn, and
   * only then here: resolves with the run as stored once it is. The store
   * settles a run still unsettled and owned by this process, whatever else
   * changed on it meanwhile; one stored settled already, by whatever
   * settled it, resolves with that stored outcome. One the store holds
   * unsettled under another owner, or no longer holds, rejects: this
   * process lost it. When the write fails this rejects, the run is not
   * settled here, and the settlement is kept and tried again on one
   * schedule, waiting longer after each failed try, and at
   * `retrySettlements`.
   */
  async settle(
    id: string,
    status: Ending,
    error?: Failure
  ): Promise<ExecutionRun | undefined> {
    this.#unsettled.delete(id);
    return await this.#settleNow(id, status, error);
  }

  async #settleNow(
    id: string,
    status: Ending,
    error?: Failure
  ): Promise<ExecutionRun | undefined> {
    const local = this.#records.get(id);
    if (!local || SETTLED_EXECUTION_STATUSES.has(local.status)) {
      return local;
    }
    let written: Written;
    try {
      written = await this.#persist(() =>
        this.#store.transition(id, settling(thisProcess(), status, error))
      );
    } catch (failure) {
      this.#unsettled.set(id, {
        ...(error === undefined ? {} : { error }),
        status,
      });
      if (!this.#retry.passing) {
        this.#scheduleRetry();
      }
      throw failure;
    }
    const stored = this.#took(id, written);
    if (
      written.applied ||
      (stored && SETTLED_EXECUTION_STATUSES.has(stored.status))
    ) {
      return stored;
    }
    throw new Error(
      stored === undefined
        ? `execution run ${id} is no longer stored; its settle is not recorded`
        : `execution run ${id} is owned by pid ${String(stored.owner.pid)} now; its settle is not recorded`
    );
  }

  /**
   * Try again every settlement whose write failed, now: rejects with every
   * failure when any still cannot be written, keeping those to try again.
   */
  async retrySettlements(): Promise<void> {
    const failures: unknown[] = [];
    this.#retry.passing = true;
    try {
      for (const [id, { error, status }] of [...this.#unsettled]) {
        this.#unsettled.delete(id);
        try {
          await this.#settleNow(id, status, error);
        } catch (failure) {
          failures.push(failure);
        }
      }
    } finally {
      this.#retry.passing = false;
    }
    if (this.#unsettled.size === 0) {
      this.#retry.wait = RETRY_FIRST_MS;
    } else {
      // The next try, once, after twice as long.
      this.#retry.wait = Math.min(this.#retry.wait * 2, RETRY_LONGEST_MS);
      this.#scheduleRetry();
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `${String(failures.length)} settlement(s) could not be recorded`
      );
    }
  }

  /** Stop the scheduled retry of failed settlements; `retrySettlements` still tries them. */
  stopRetrying(): void {
    clearTimeout(this.#retry.timer);
    this.#retry.timer = undefined;
  }

  /**
   * One retry of every failed settlement, scheduled once however many
   * fail; a try that still fails schedules the next, after twice as long
   * (`retrySettlements`).
   */
  #scheduleRetry(): void {
    if (this.#retry.timer !== undefined) {
      return;
    }
    const timer = setTimeout(() => {
      this.#retry.timer = undefined;
      this.retrySettlements().catch(() => undefined);
    }, this.#retry.wait);
    timer.unref?.();
    this.#retry.timer = timer;
  }

  /**
   * Hold what `written` gave back of the run `id`, with `observations`
   * when the write changed them, and return it; `undefined` when the
   * store does not hold the run.
   */
  #took(
    id: string,
    written: Written,
    observations?: readonly ExecutionObservation[]
  ): ExecutionRun | undefined {
    if (written.record === undefined) {
      return;
    }
    const run = parseStored({
      id,
      observations: observations ?? this.#records.get(id)?.observations ?? [],
      value: written.record,
    });
    this.#learn(run);
    return run;
  }

  /** `write`, once every write made before it has landed or failed. */
  #persist<T>(write: () => Promise<T>): Promise<T> {
    const landing = this.#writes.then(write);
    this.#writes = landing.catch(() => undefined);
    return landing;
  }

  /**
   * Hold `stored`, what the store holds of a run, when it is a later
   * revision than this process holds: the store's revision is the order,
   * and one revision is one record.
   */
  #learn(stored: ExecutionRun | undefined): void {
    if (stored === undefined) {
      return;
    }
    const local = this.#records.get(stored.id);
    if (!local || stored.revision > local.revision) {
      this.#publish(stored);
    }
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
  options: Parameters<ExecutionRecords["recover"]>[0],
  judgedGone: boolean
): { readonly change: LifecycleChange; readonly readmit: boolean } | undefined {
  const ours = options.adopted.has(run.id);
  if (SETTLED_EXECUTION_STATUSES.has(run.status) || !(ours || judgedGone)) {
    return;
  }
  const at = now();
  const from = [run.status];
  const { owner } = run;
  if (ours) {
    // Its Run is parked: the record may have missed the park.
    return {
      change: {
        from,
        newOwner: thisProcess(),
        owner,
        status: run.status === "running" ? "suspended" : run.status,
        updatedAt: at,
      },
      readmit: false,
    };
  }
  if (run.status === "queued") {
    return options.readmit(run)
      ? {
          change: {
            from,
            newOwner: thisProcess(),
            owner,
            status: "queued",
            updatedAt: at,
          },
          readmit: true,
        }
      : undefined;
  }
  const ending = reconciled(run, options.fileStatus?.(run));
  if (ending === undefined) {
    return;
  }
  if (ending === "suspended") {
    return {
      change: { from, owner, status: "suspended", updatedAt: at },
      readmit: false,
    };
  }
  return {
    change: {
      ...settling(
        owner,
        ending,
        ending === "interrupted" ? INTERRUPTED : undefined,
        thisProcess()
      ),
      from,
    },
    readmit: false,
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
