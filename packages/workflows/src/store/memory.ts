import { Turns } from "@foundry/lib/turns";

import { detached } from "../detached";
import type {
  JobRecord,
  OrchestratorStoreSnapshot,
  QueueRecord,
  RunFrame,
  RunRecord,
  SuspensionRecord,
} from "../schema";
import { ORCHESTRATOR_STORE_SNAPSHOT_VERSION } from "../schema";
import { capturedWrite } from "./captured";
import type {
  FrameListQuery,
  JobListQuery,
  RunListQuery,
  SuspensionListQuery,
  WorkflowStore,
  WorkflowStorePage,
  WorkflowStorePageQuery,
  WorkflowStoreWrite,
} from "./index";
import { ownedQuery } from "./page";

/** Why a call from inside the store's own transaction is refused. */
const REENTRY =
  "MemoryWorkflowStore was called from inside its own transaction; use the view passed to the transaction's work instead";

/** Why a view used after its transaction settled is refused. */
const ENDED =
  "MemoryWorkflowStore transaction view was used after its transaction settled";

/**
 * The default store: plain maps in this process. Reads list records in the
 * order they were first put; a put over a stored record keeps its place.
 * Every call takes a turn, so a commit made while a transaction runs lands
 * after it, and a call made from inside a transaction's work is refused.
 *
 * A transaction stages its commits on a copy of the store's tables, taken
 * at its first commit, and swaps the copy in only if its work succeeds. The
 * tables the store holds are therefore always the last completed state,
 * which {@link snapshot} reads at once.
 */
export class MemoryWorkflowStore implements WorkflowStore {
  /** A commit lands in this process's maps at once, for good. */
  readonly durability = "commit";
  #tables = new Tables();
  readonly #turns = new Turns(REENTRY);

  /**
   * Copies `write` when called, before waiting for its turn, so a caller
   * changing it afterwards changes nothing the store keeps; a value that
   * cannot be copied refuses the whole write.
   */
  commit(write: WorkflowStoreWrite): Promise<void> {
    let copied: OwnedWrite;
    try {
      copied = owned(write);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#turns.run(() => {
      this.#tables.apply(copied);
      return Promise.resolve();
    });
  }

  /**
   * Runs `work` over a view that stages its commits, and keeps them only if
   * `work` succeeds, so a throw after a commit through `view` leaves
   * nothing.
   */
  transaction<T>(work: (view: WorkflowStore) => Promise<T>): Promise<T> {
    return this.#turns.run(async () => {
      const view = new MemoryView(this.#tables);
      try {
        const result = await work(view);
        this.#tables = view.tables;
        return result;
      } finally {
        view.end();
      }
    });
  }

  getJob(id: string): Promise<JobRecord | null> {
    return this.#read((tables) => tables.get(tables.jobs, id));
  }

  getQueue(id: string): Promise<QueueRecord | null> {
    return this.#read((tables) => tables.get(tables.queues, id));
  }

  getRun(id: string): Promise<RunRecord | null> {
    return this.#read((tables) => tables.get(tables.runs, id));
  }

  getSuspension(id: string): Promise<SuspensionRecord | null> {
    return this.#read((tables) => tables.get(tables.suspensions, id));
  }

  listFrames(query: FrameListQuery): Promise<WorkflowStorePage<RunFrame>> {
    return this.#list(query, (tables, taken) => tables.listFrames(taken));
  }

  listJobs(query: JobListQuery): Promise<WorkflowStorePage<JobRecord>> {
    return this.#list(query, (tables, taken) => tables.listJobs(taken));
  }

  listQueues(): Promise<readonly QueueRecord[]> {
    return this.#read((tables) => tables.listQueues());
  }

  listRuns(query: RunListQuery): Promise<WorkflowStorePage<RunRecord>> {
    return this.#list(query, (tables, taken) => tables.listRuns(taken));
  }

  listSuspensions(
    query: SuspensionListQuery
  ): Promise<WorkflowStorePage<SuspensionRecord>> {
    return this.#list(query, (tables, taken) => tables.listSuspensions(taken));
  }

  /**
   * Every record as of the last commit or transaction that completed, read
   * at once without waiting for a turn, in the store's list order. Not part
   * of `WorkflowStore`: it lets a host that keeps its own files (Marbles)
   * read the state synchronously. The records are copies, not checked
   * against each other; `ExecutionCoordinator.snapshot` returns a checked
   * one.
   */
  snapshot(): OrchestratorStoreSnapshot {
    return this.#tables.snapshot();
  }

  #read<T>(read: (tables: Tables) => T): Promise<T> {
    return this.#turns.run(() => Promise.resolve(read(this.#tables)));
  }

  #list<Q extends WorkflowStorePageQuery, T>(
    query: Q,
    read: (tables: Tables, query: Q) => WorkflowStorePage<T>
  ): Promise<WorkflowStorePage<T>> {
    let taken: Q;
    try {
      taken = ownedQuery(query);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#read((tables) => read(tables, taken));
  }
}

/**
 * A transaction's view: reads see the store's tables until the first
 * commit, which copies them; later commits change only the copy.
 */
class MemoryView implements WorkflowStore {
  /** Its commits stand only if the transaction's work succeeds. */
  readonly durability = "host";
  tables: Tables;
  readonly #base: Tables;
  #ended: boolean;

  constructor(tables: Tables) {
    this.tables = tables;
    this.#base = tables;
    this.#ended = false;
  }

  end(): void {
    this.#ended = true;
  }

  commit(write: WorkflowStoreWrite): Promise<void> {
    return this.#run(() => {
      const copied = owned(write);
      if (this.tables === this.#base) {
        this.tables = this.#base.copy();
      }
      this.tables.apply(copied);
    });
  }

  getJob(id: string): Promise<JobRecord | null> {
    return this.#run(() => this.tables.get(this.tables.jobs, id));
  }

  getQueue(id: string): Promise<QueueRecord | null> {
    return this.#run(() => this.tables.get(this.tables.queues, id));
  }

  getRun(id: string): Promise<RunRecord | null> {
    return this.#run(() => this.tables.get(this.tables.runs, id));
  }

  getSuspension(id: string): Promise<SuspensionRecord | null> {
    return this.#run(() => this.tables.get(this.tables.suspensions, id));
  }

  listFrames(query: FrameListQuery): Promise<WorkflowStorePage<RunFrame>> {
    return this.#run(() => this.tables.listFrames(ownedQuery(query)));
  }

  listJobs(query: JobListQuery): Promise<WorkflowStorePage<JobRecord>> {
    return this.#run(() => this.tables.listJobs(ownedQuery(query)));
  }

  listQueues(): Promise<readonly QueueRecord[]> {
    return this.#run(() => this.tables.listQueues());
  }

  listRuns(query: RunListQuery): Promise<WorkflowStorePage<RunRecord>> {
    return this.#run(() => this.tables.listRuns(ownedQuery(query)));
  }

  listSuspensions(
    query: SuspensionListQuery
  ): Promise<WorkflowStorePage<SuspensionRecord>> {
    return this.#run(() => this.tables.listSuspensions(ownedQuery(query)));
  }

  #run<T>(operation: () => T): Promise<T> {
    if (this.#ended) {
      return Promise.reject(new Error(ENDED));
    }
    try {
      return Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

/** A stored record and its place in its table's list order. */
interface Row<T> {
  readonly position: number;
  readonly record: T;
}

/** A write's records, copied so they share nothing with the caller's. */
interface OwnedWrite {
  readonly deleteJobs: readonly string[];
  readonly deleteRunFrames: readonly string[];
  readonly deleteRuns: readonly string[];
  readonly deleteSuspensions: readonly string[];
  readonly putFrames: readonly RunFrame[];
  readonly putJobs: readonly JobRecord[];
  readonly putQueues: readonly QueueRecord[];
  readonly putRuns: readonly RunRecord[];
  readonly putSuspensions: readonly SuspensionRecord[];
}

/**
 * The store's own copy of `write`: the named properties read once
 * (`capturedWrite`, as the SQLite store reads them), then one deep copy of
 * that capture with byte memory unshared (`detached`).
 */
function owned(write: WorkflowStoreWrite): OwnedWrite {
  const copy = detached(capturedWrite(write));
  return {
    deleteJobs: copy.deleteJobs ?? [],
    deleteRunFrames: copy.deleteRunFrames ?? [],
    deleteRuns: copy.deleteRuns ?? [],
    deleteSuspensions: copy.deleteSuspensions ?? [],
    putFrames: copy.putFrames ?? [],
    putJobs: copy.putJobs ?? [],
    putQueues: copy.putQueues ?? [],
    putRuns: copy.putRuns ?? [],
    putSuspensions: copy.putSuspensions ?? [],
  };
}

/**
 * The store's records. Rows are never changed in place, so a copy shares
 * them; each Run's frame map is copied the first time a copy writes to it.
 */
class Tables {
  readonly queues: Map<string, Row<QueueRecord>>;
  readonly jobs: Map<string, Row<JobRecord>>;
  readonly runs: Map<string, Row<RunRecord>>;
  readonly suspensions: Map<string, Row<SuspensionRecord>>;
  /** Run id → cursor → frame. */
  readonly frames: Map<string, Map<number, Row<RunFrame>>>;
  /** Frame maps this copy may change: its own, not shared with the original. */
  readonly #ownFrames = new Set<string>();
  #next: number;

  constructor(from?: Tables) {
    this.queues = new Map(from?.queues);
    this.jobs = new Map(from?.jobs);
    this.runs = new Map(from?.runs);
    this.suspensions = new Map(from?.suspensions);
    this.frames = new Map(from?.frames);
    this.#next = from === undefined ? 1 : from.#next;
  }

  copy(): Tables {
    return new Tables(this);
  }

  get<T>(table: ReadonlyMap<string, Row<T>>, id: string): T | null {
    const row = table.get(id);
    return row === undefined ? null : detached(row.record);
  }

  apply(write: OwnedWrite): void {
    for (const id of write.deleteJobs) {
      this.jobs.delete(id);
    }
    for (const id of write.deleteRuns) {
      this.runs.delete(id);
    }
    for (const id of write.deleteSuspensions) {
      this.suspensions.delete(id);
    }
    for (const runId of write.deleteRunFrames) {
      this.frames.delete(runId);
      this.#ownFrames.delete(runId);
    }
    for (const queue of write.putQueues) {
      this.#put(this.queues, queue.id, queue);
    }
    for (const job of write.putJobs) {
      this.#put(this.jobs, job.id, job);
    }
    for (const run of write.putRuns) {
      this.#put(this.runs, run.id, run);
    }
    for (const suspension of write.putSuspensions) {
      this.#put(this.suspensions, suspension.id, suspension);
    }
    for (const frame of write.putFrames) {
      this.#put(this.#framesOf(frame.runId), frame.cursor, frame);
    }
  }

  listQueues(): QueueRecord[] {
    return ordered([...this.queues.values()]).map((row) =>
      detached(row.record)
    );
  }

  listJobs(query: JobListQuery): WorkflowStorePage<JobRecord> {
    return page(
      [...this.jobs.values()],
      query,
      (job) => query.status === undefined || query.status.includes(job.status)
    );
  }

  listRuns(query: RunListQuery): WorkflowStorePage<RunRecord> {
    return page(
      [...this.runs.values()],
      query,
      (run) =>
        (query.queueId === undefined || run.queueId === query.queueId) &&
        (query.status === undefined || query.status.includes(run.status))
    );
  }

  listSuspensions(
    query: SuspensionListQuery
  ): WorkflowStorePage<SuspensionRecord> {
    return page(
      [...this.suspensions.values()],
      query,
      (suspension) =>
        (query.runId === undefined || suspension.runId === query.runId) &&
        (query.status === undefined || query.status.includes(suspension.status))
    );
  }

  listFrames(query: FrameListQuery): WorkflowStorePage<RunFrame> {
    const rows =
      query.runId === undefined
        ? [...this.frames.values()].flatMap((frames) => [...frames.values()])
        : [...(this.frames.get(query.runId)?.values() ?? [])];
    return page(rows, query, () => true);
  }

  snapshot(): OrchestratorStoreSnapshot {
    const records = <T>(rows: Iterable<Row<T>>): T[] =>
      ordered([...rows]).map((row) => detached(row.record));
    return {
      frames: records(
        [...this.frames.values()].flatMap((frames) => [...frames.values()])
      ),
      jobs: records(this.jobs.values()),
      queues: records(this.queues.values()),
      runs: records(this.runs.values()),
      suspensions: records(this.suspensions.values()),
      version: ORCHESTRATOR_STORE_SNAPSHOT_VERSION,
    };
  }

  /** A new key takes the next position; one put again keeps its own. */
  #put<K, T>(table: Map<K, Row<T>>, key: K, record: T): void {
    const position = table.get(key)?.position ?? this.#take();
    table.set(key, { position, record });
  }

  #take(): number {
    const position = this.#next;
    this.#next += 1;
    return position;
  }

  /** The Run's frame map, copied first if this copy shares it. */
  #framesOf(runId: string): Map<number, Row<RunFrame>> {
    const shared = this.frames.get(runId);
    if (shared !== undefined && this.#ownFrames.has(runId)) {
      return shared;
    }
    const own = new Map(shared);
    this.frames.set(runId, own);
    this.#ownFrames.add(runId);
    return own;
  }
}

function ordered<T>(rows: Row<T>[]): Row<T>[] {
  return rows.sort((left, right) => left.position - right.position);
}

/** The matching rows after `query.after`, at most `query.limit`, as copies. */
function page<T>(
  rows: Row<T>[],
  query: WorkflowStorePageQuery,
  matches: (record: T) => boolean
): WorkflowStorePage<T> {
  const after = query.after ?? 0;
  const found = ordered(rows).filter(
    (row) => row.position > after && matches(row.record)
  );
  const items = found.slice(0, query.limit);
  const last = items.at(-1);
  return {
    items: items.map((row) => detached(row.record)),
    ...(found.length > items.length && last !== undefined
      ? { next: last.position }
      : {}),
  };
}
