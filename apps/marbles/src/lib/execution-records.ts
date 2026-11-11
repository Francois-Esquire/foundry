import { createHash, randomUUID } from "node:crypto";
import { processAlive } from "@foundry/lib/file-lock";
import type { JsonValue } from "@foundry/lib/json";
import {
  bySequence,
  DEFAULT_QUEUE,
  type EnqueueInput,
  type ExecutionObservation,
  type ExecutionRun,
  type ExecutionSubscription,
  indexOf,
  isLogged,
  jsonInput,
  type LoggedObservation,
  nextRevision,
  now,
  parseGaps,
  parseRun,
  type RetentionGap,
  withObservation,
} from "./execution-record";
import { SETTLED_EXECUTION_STATUSES } from "./execution-statuses";
import { isRecord } from "./state/json";
import type { Lock } from "./state/locks";
import type { StateStore } from "./state/store";

const GAPS_KEY = "gaps";

/**
 * A lock name for one source of one name: plain whatever the source holds,
 * since a lock name is a file name.
 */
function sourceLock(name: string, source: string): string {
  return `source-${createHash("sha256").update(name).update("\0").update(source).digest("hex")}`;
}

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
/** Storage and cleanup owned by the durable execution authority. */
export interface ExecutionRecordsOptions {
  /**
   * Told of each settled run being pruned, before its record goes, to
   * drop what else it kept. One that throws keeps the record, so pruning
   * it again retries.
   */
  readonly removed?: (run: ExecutionRun) => void;
  readonly store: StateStore;
  readonly warn: (line: string) => void;
}

/** Canonical execution records: persistence, logs, snapshots, retention and owner recovery. */
export class ExecutionRecords {
  readonly #store: StateStore;
  readonly #warn: (line: string) => void;
  readonly #records = new Map<string, ExecutionRun>();
  readonly #listeners = new Set<(run: ExecutionRun) => void>();
  readonly #removed: (run: ExecutionRun) => void;
  /** Each record's observation positions by id, for the array it was built for. */
  readonly #indexes = new WeakMap<
    readonly ExecutionObservation[],
    Map<string, number>
  >();
  /**
   * Whether the store keeps per-run logs: then an unsettled run's
   * observations are appended there one at a time. A store without them
   * (written before `append` and `log` existed) gets each observation by
   * rewriting the run's whole record instead, which is durable at once too.
   */
  readonly #logged: boolean;
  #gaps = new Map<string, RetentionGap>();
  #sequence = 0;

  constructor(options: ExecutionRecordsOptions) {
    this.#store = options.store;
    this.#logged =
      typeof options.store.append === "function" &&
      typeof options.store.log === "function";
    this.#warn = options.warn;
    this.#removed = options.removed ?? (() => undefined);
  }

  gaps(): readonly RetentionGap[] {
    return [...this.#gaps.values()];
  }

  get(id: string): ExecutionRun | undefined {
    return this.#records.get(id);
  }

  prune(
    ids: Iterable<string>,
    scopeOf: (run: ExecutionRun) => string
  ): readonly ExecutionRun[] {
    const lock = this.#store.lock("retention-gaps");
    if ("holder" in lock) {
      throw new Error(`retention is being updated by ${lock.holder}`);
    }
    try {
      return this.#prune(ids, scopeOf);
    } finally {
      lock.release();
    }
  }

  /** Cleanup and gap accounting are one shared-store critical section. */
  #prune(
    ids: Iterable<string>,
    scopeOf: (run: ExecutionRun) => string
  ): readonly ExecutionRun[] {
    const candidates = [...new Set(ids)].flatMap((id) => {
      const run = this.#records.get(id);
      const retained = this.#store.read("executions", id) !== undefined;
      return retained && run && SETTLED_EXECUTION_STATUSES.has(run.status)
        ? [run]
        : [];
    });
    // Failed cleanup leaves its record for a retry and is not a removal.
    const runs = candidates.filter((run) => {
      try {
        this.#removed(run);
        return true;
      } catch (error) {
        this.#warn(`[state] run ${run.id} not removed: ${String(error)}`);
        return false;
      }
    });
    if (runs.length === 0) {
      return [];
    }
    const at = now();
    const gaps = parseGaps(this.#store.read("retention", GAPS_KEY));
    for (const run of runs) {
      const scope = scopeOf(run);
      const gap = gaps.get(scope);
      const settled = run.timestamps.settledAt ?? run.timestamps.updatedAt;
      gaps.set(scope, {
        removed: (gap?.removed ?? 0) + 1,
        scope,
        through: gap && gap.through > settled ? gap.through : settled,
        updatedAt: at,
      });
    }
    // The gap is on disk before any record goes: a crash in between claims
    // a gap a little early, never hides one.
    this.#store.write("retention", GAPS_KEY, {
      gaps: Object.fromEntries(
        [...gaps].map(([key, gap]) => [
          key,
          {
            removed: gap.removed,
            through: gap.through,
            updatedAt: gap.updatedAt,
          },
        ])
      ),
    });
    this.#gaps = gaps;
    const removed: ExecutionRun[] = [];
    for (const run of runs) {
      try {
        this.#store.remove("executions", run.id);
        if (this.#logged) {
          // Nothing, unless a crash came between settling and dropping it.
          this.#store.remove("observations", run.id);
        }
      } catch (error) {
        this.#warn(`[state] execution ${run.id} not removed: ${String(error)}`);
        continue;
      }
      this.#records.delete(run.id);
      removed.push(run);
    }
    return removed;
  }

  list(): readonly ExecutionRun[] {
    return [...this.#records.values()].sort(bySequence);
  }

  subscribe(listener: (run: ExecutionRun) => void): ExecutionSubscription {
    this.#refresh();
    this.#listeners.add(listener);
    return {
      snapshot: this.list(),
      unsubscribe: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  /**
   * Read what the store retains; an unreadable record is skipped with a
   * warning, and so is an observation that is not one.
   */
  load(): void {
    this.#gaps = parseGaps(this.#store.read("retention", GAPS_KEY));
    for (const run of this.#stored()) {
      this.#records.set(run.id, run);
      this.#sequence = Math.max(this.#sequence, run.sequence);
    }
  }

  /** Every readable record in the store, its log folded in. */
  #stored(): ExecutionRun[] {
    const runs: ExecutionRun[] = [];
    for (const document of this.#store.list("executions")) {
      const run = this.#folded(this.#parse(document.value, document.key));
      if (run === undefined) {
        this.#warn(
          `[state] skipped executions/${document.key}: ${document.error ?? "not an execution run"}`
        );
        continue;
      }
      runs.push(run);
    }
    return runs;
  }

  /** A stored record, warning of each observation in it that is not one. */
  #parse(value: unknown, key: string): ExecutionRun | undefined {
    return parseRun(value, (count) =>
      this.#warn(
        `[state] skipped ${String(count)} unreadable observation(s) in executions/${key}`
      )
    );
  }

  /**
   * Take in what other processes sharing the store wrote since this one
   * read it: a record they changed (a higher revision) and one they
   * pruned. What this process owns and has not settled is its own to say,
   * and stays even when its write failed.
   */
  #refresh(): void {
    let stored: ExecutionRun[];
    try {
      stored = this.#stored();
    } catch (error) {
      this.#warn(`[state] executions not refreshed: ${String(error)}`);
      return;
    }
    const seen = new Set<string>();
    for (const run of stored) {
      seen.add(run.id);
      this.#sequence = Math.max(this.#sequence, run.sequence);
      const local = this.#records.get(run.id);
      if (local && (ownedHere(local) || local.revision >= run.revision)) {
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
   * instead. Throws when the record cannot be written: a run that is not
   * recorded does not exist.
   */
  enqueue(request: EnqueueInput): {
    readonly existing: boolean;
    readonly run: ExecutionRun;
  } {
    // Before anything is recorded: an input that is not JSON never queues.
    const input =
      request.input === undefined ? undefined : jsonInput(request.input);
    if (request.source === undefined) {
      return { existing: false, run: this.#enqueue(request, input) };
    }
    const { source } = request;
    const local = this.#withSource(request.name, source);
    if (local) {
      return { existing: true, run: local };
    }
    // Another engine sharing the store may be launching the same source:
    // its lock makes the look and the write one step across them.
    const lock = this.#store.lock(sourceLock(request.name, source));
    if ("holder" in lock) {
      throw new Error(
        `"${request.name}" source ${JSON.stringify(source)} is being launched by ${lock.holder}`
      );
    }
    try {
      const stored = this.#storedWithSource(request.name, source);
      if (stored) {
        this.#records.set(stored.id, stored);
        this.#sequence = Math.max(this.#sequence, stored.sequence);
        return { existing: true, run: stored };
      }
      return { existing: false, run: this.#enqueue(request, input) };
    } finally {
      lock.release();
    }
  }

  /** The retained run this process knows of for a name and source. */
  #withSource(name: string, source: string): ExecutionRun | undefined {
    return [...this.#records.values()].find(
      (candidate) => candidate.source === source && candidate.name === name
    );
  }

  /** The run the store holds for a name and source, written by any process. */
  #storedWithSource(name: string, source: string): ExecutionRun | undefined {
    for (const document of this.#store.list("executions")) {
      const { value } = document;
      if (isRecord(value) && value.source === source && value.name === name) {
        const run = this.#folded(this.#parse(value, document.key));
        if (run) {
          return run;
        }
      }
    }
    return undefined;
  }

  #enqueue(request: EnqueueInput, input: JsonValue | undefined): ExecutionRun {
    this.#sequence = Math.max(Date.now(), this.#sequence + 1);
    const at = now();
    const run: ExecutionRun = {
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
    this.writeRecord(run);
    return run;
  }

  progress(id: string, value: JsonValue): void {
    this.changeRecord(id, { progress: value });
  }

  /**
   * Record or replace an observation by id, appended to the run's log. True
   * once it is durably recorded; false for an unknown or settled run, or a
   * failed write (the change still holds in this process). `keepStart`
   * says the observation's `startedAt` was not given: replacing one keeps
   * the start it was first recorded with.
   */
  observe(
    id: string,
    observation: ExecutionObservation,
    options?: { readonly keepStart?: boolean }
  ): boolean {
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
    this.#indexes.set(observations, index);
    const changed = nextRevision(run, { observations });
    const recorded = observations.at(-1) ?? observation;
    if (!this.#logged) {
      return this.#commit(changed);
    }
    try {
      // `append` is optional on the type; `#logged` says this store has it.
      this.#store.append?.("observations", id, {
        observation: recorded,
        revision: changed.revision,
        updatedAt: changed.timestamps.updatedAt,
      } satisfies LoggedObservation);
      return true;
    } catch (error) {
      this.#warn(
        `[state] execution ${id} observation not saved: ${String(error)}`
      );
      return false;
    } finally {
      this.#publish(changed);
    }
  }

  /**
   * Record a parked workflow run adopted from a run file that has no
   * Execution Run, one written before they existed, so it is listed, records
   * its progress, and can be pruned once it settles. Nothing for a run
   * already recorded. `createdAt` (ms) orders it among the others.
   */
  adoptParked(run: {
    readonly createdAt: number;
    readonly id: string;
    readonly name: string;
  }): void {
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
    this.#commit({
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

  /** Whether the store holds the run's record settled, read afresh. */
  storedSettled(id: string): boolean {
    const run = parseRun(this.#store.read("executions", id));
    return run !== undefined && SETTLED_EXECUTION_STATUSES.has(run.status);
  }

  /**
   * Record cancelled an unsettled run whose owner has exited and that no
   * process has adopted; `false`, changing nothing, otherwise. It holds the
   * run's `execution-<id>` lock and, for a workflow, the `run-<id>` lock an
   * adopter takes before it reads the record and keeps for as long as it
   * owns the run, and reads the record and its owner again under them. A
   * run file left parked stays on disk until the run is pruned; a process
   * that would adopt it finds the record settled under that lock and
   * leaves it (see {@link storedSettled}).
   */
  cancelOrphan(id: string): boolean {
    const known = this.#records.get(id);
    if (
      !known ||
      SETTLED_EXECUTION_STATUSES.has(known.status) ||
      !exited(known.owner.pid)
    ) {
      return false;
    }
    const held: Lock[] = [];
    try {
      for (const name of known.kind === "workflow"
        ? [`run-${id}`, `execution-${id}`]
        : [`execution-${id}`]) {
        const lock = this.#store.lock(name);
        if ("holder" in lock) {
          return false;
        }
        held.push(lock);
      }
      const run = this.#folded(
        this.#parse(this.#store.read("executions", id), id)
      );
      if (
        !run ||
        SETTLED_EXECUTION_STATUSES.has(run.status) ||
        !exited(run.owner.pid)
      ) {
        if (run) {
          // Refresh what this process saw: an adopter may own it now.
          this.#publish(run);
        }
        return false;
      }
      this.#records.set(id, run);
      this.changeRecord(id, { owner: { pid: process.pid } });
      this.settle(id, "cancelled");
      return true;
    } finally {
      for (const lock of held.reverse()) {
        lock.release();
      }
    }
  }

  /**
   * Take over the unsettled runs of processes that have exited. Running
   * work is recorded `interrupted`. A parked run this engine adopted is now
   * its own, and suspended. A queued run `readmit` accepts is now its own,
   * once that is on disk, and is returned, in admission order, for the
   * caller to admit; any other is left queued for a process that can run
   * it.
   *
   * A workflow's own run file can be ahead of its record, written just
   * before its process exited: one that settled settles the record the same
   * way; one parked leaves the record suspended for a process to adopt; one
   * resumed and running again was mid-flight, so the record is interrupted.
   * A suspended record without a readable file is left for adoption.
   */
  recover(options: {
    readonly adopted: ReadonlySet<string>;
    /** What a workflow run's own file says its status is; `undefined` without one. */
    readonly fileStatus?: (run: ExecutionRun) => string | undefined;
    readonly readmit: (run: ExecutionRun) => boolean;
  }): readonly ExecutionRun[] {
    const readmitted: ExecutionRun[] = [];
    const orphans = this.list().filter(
      (run) =>
        !SETTLED_EXECUTION_STATUSES.has(run.status) &&
        (options.adopted.has(run.id) || exited(run.owner.pid))
    );
    for (const orphan of orphans) {
      const lock = this.#store.lock(`execution-${orphan.id}`);
      if ("holder" in lock) {
        continue;
      }
      try {
        const taken = this.#recoverOne(orphan.id, options);
        if (taken) {
          readmitted.push(taken);
        }
      } finally {
        lock.release();
      }
    }
    return readmitted.sort(bySequence);
  }

  /**
   * Recover one run, its `execution-<id>` lock held: read afresh, it is
   * left alone if it settled or a live process owns it. Returns it when it
   * is a queued run now this process's to admit.
   */
  #recoverOne(
    id: string,
    options: Parameters<ExecutionRecords["recover"]>[0]
  ): ExecutionRun | undefined {
    const run = this.#folded(
      this.#parse(this.#store.read("executions", id), id)
    );
    const ours = run && options.adopted.has(run.id);
    if (
      !run ||
      SETTLED_EXECUTION_STATUSES.has(run.status) ||
      !(ours || exited(run.owner.pid))
    ) {
      return;
    }
    this.#records.set(run.id, run);
    if (ours) {
      // Its file is parked: the record may have missed the park.
      this.changeRecord(run.id, {
        owner: { pid: process.pid },
        ...(run.status === "running" ? { status: "suspended" } : {}),
      });
    } else if (run.status === "queued") {
      return options.readmit(run) ? this.#take(run) : undefined;
    } else {
      this.#reconcile(run, options.fileStatus?.(run));
    }
  }

  /**
   * Own a queued run, on disk before anything admits it: a write that fails
   * leaves it for another process to take, never run by two.
   */
  #take(run: ExecutionRun): ExecutionRun | undefined {
    const owned = nextRevision(run, { owner: { pid: process.pid } });
    try {
      this.writeRecord(owned);
      return owned;
    } catch (error) {
      this.#warn(
        `[state] execution ${run.id} not taken over, left queued: ${String(error)}`
      );
      return undefined;
    }
  }

  /** Settle or leave a running or parked run an exited process left, as its file says. */
  #reconcile(run: ExecutionRun, file: string | undefined): void {
    const interrupt = () => {
      this.changeRecord(run.id, { owner: { pid: process.pid } });
      this.settle(run.id, "interrupted", {
        code: "interrupted",
        message: "its process exited while it was running",
      });
    };
    if (run.kind === "task") {
      if (run.status === "running") {
        interrupt();
      }
      return;
    }
    if (file === "complete" || file === "failed" || file === "cancelled") {
      this.changeRecord(run.id, { owner: { pid: process.pid } });
      this.settle(run.id, file);
    } else if (file === "suspended") {
      // Parked for a process that can answer it; ownership stays open.
      if (run.status === "running") {
        this.changeRecord(run.id, { status: "suspended" });
      }
    } else if (file !== undefined || run.status === "running") {
      // Resumed and running when its process exited, or never parked.
      interrupt();
    }
  }

  /**
   * Apply a change to a known, unsettled run; a failed write warns and the
   * change still holds here. A settled run never changes.
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

  /** Persist and publish; a failed write warns, publishes anyway and returns false. */
  #commit(run: ExecutionRun): boolean {
    try {
      this.writeRecord(run);
      return true;
    } catch (error) {
      this.#warn(`[state] execution ${run.id} not saved: ${String(error)}`);
      this.#publish(run);
      return false;
    }
  }

  /**
   * Persist, then publish. Throws when the store refuses the write. An
   * unsettled run's observations stay in its log; the settled record takes
   * them, and only once it is written does the log go.
   */
  protected writeRecord(run: ExecutionRun): void {
    const settled = SETTLED_EXECUTION_STATUSES.has(run.status);
    const { observations: _observations, ...unsettled } = run;
    this.#store.write(
      "executions",
      run.id,
      (settled || !this.#logged ? run : unsettled) as unknown as Record<
        string,
        unknown
      >
    );
    this.#publish(run);
    if (settled && this.#logged) {
      try {
        this.#store.remove("observations", run.id);
      } catch (error) {
        this.#warn(
          `[state] execution ${run.id} log not removed: ${String(error)}`
        );
      }
    }
  }

  /** A stored unsettled run with its logged observations folded back in. */
  #folded(run: ExecutionRun | undefined): ExecutionRun | undefined {
    if (!(run && this.#logged) || SETTLED_EXECUTION_STATUSES.has(run.status)) {
      return run;
    }
    const observations = new Map(
      run.observations.map((item) => [item.id, item])
    );
    let { revision } = run;
    let { updatedAt } = run.timestamps;
    for (const entry of this.#store.log?.("observations", run.id) ?? []) {
      if (isLogged(entry)) {
        // Replacing one by id moves it last, as `observe` does.
        observations.delete(entry.observation.id);
        observations.set(entry.observation.id, entry.observation);
        revision = Math.max(revision, entry.revision);
        updatedAt = entry.updatedAt > updatedAt ? entry.updatedAt : updatedAt;
      }
    }
    return {
      ...run,
      observations: [...observations.values()],
      revision,
      timestamps: { ...run.timestamps, updatedAt },
    };
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

  /** Record how a run ended and free its slot. */
  settle(
    id: string,
    status: "complete" | "failed" | "cancelled" | "interrupted",
    error?: { readonly code: string; readonly message?: string }
  ): void {
    const run = this.#records.get(id);
    if (!run || SETTLED_EXECUTION_STATUSES.has(run.status)) {
      return;
    }
    const at = now();
    const { input: _input, ...rest } = run;
    this.#commit({
      ...rest,
      ...(error === undefined ? {} : { error }),
      revision: run.revision + 1,
      status,
      timestamps: { ...run.timestamps, settledAt: at, updatedAt: at },
    });
  }
}
