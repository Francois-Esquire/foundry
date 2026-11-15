import { dirname, resolve } from "node:path";
import type { SessionMessage, SessionRecord } from "@foundry/agents/schema";
import type { SessionStore, SessionStoreWrite } from "@foundry/agents/store";
import { capturedSessionWrite } from "@foundry/agents/store/sqlite";
import type { JsonValue } from "@foundry/lib/json";
import type { TaskStore, TaskStoreWrite } from "@foundry/tasks";
import type { WorkflowStore } from "@foundry/workflows/store";
import { DatabaseActivityStore } from "~/database/activities";
import { DatabaseDeferredApprovalStore } from "~/database/approvals";
import { DatabaseAutomationStore } from "~/database/automations";
import { DatabaseExecutionStore } from "~/database/executions";
import { DatabaseGrantStorage } from "~/database/grants";
import type { MarblesDatabase, StoreDatabase } from "~/database/open";
import { DatabaseRunStore } from "~/database/runs";
import { DatabaseSessionStore } from "~/database/sessions";
import { DatabaseWorkspaceRecords } from "~/database/tasks";
import { DatabaseTriggerStore } from "~/database/triggers";
import { DatabaseUsageStore } from "~/database/usage";
import type { HostDatabaseOptions } from "~/database/workspaces";
import { openHostDatabase } from "~/database/workspaces";
import type { AutomationRecord } from "~/lib/automation/service";
import type {
  AutomationStore,
  AutomationView,
  StoredAutomation,
} from "~/lib/automation/store";
import { storedAutomation } from "~/lib/automation/store";
import type { EngineOptions } from "~/lib/engine";
import type {
  PendingQuery,
  StreamItem,
  WorkspaceRecords,
} from "~/lib/events/records";
import { EmitListeners, RecordsGate } from "~/lib/events/records";
import type {
  ExecutionObservation,
  ExecutionRun,
  RetentionGap,
} from "~/lib/execution-record";
import type {
  ExecutionStore,
  ExecutionView,
  LifecycleChange,
  StoredExecution,
  Written,
} from "~/lib/execution-store";
import {
  storedChange,
  storedExecutionRun,
  storedObservation,
  storedProgress,
  storedRetentionGap,
} from "~/lib/execution-store";
import type { RecordedScope } from "~/lib/run-scope";
import type {
  ClaimCondition,
  RunFollower,
  RunStore,
  StoredScope,
} from "~/lib/run-store";
import type { Workspace } from "~/lib/state/workspace";
import { workspaceState } from "~/lib/state/workspace";
import type {
  MonitorState,
  ScheduleHistory,
  TickClaim,
  TriggerStore,
} from "~/lib/trigger-store";
import type { RecordedUsageFact } from "~/lib/usage";
import type { ListedSessionStore, SessionStamp } from "~/lib/usage-evidence";
import type { StoredUsage, UsageStore } from "~/lib/usage-store";
import { storedUsageFact } from "~/lib/usage-store";

export interface OpenWorkspaceRecordsOptions extends HostDatabaseOptions {
  /** The Marbles state root, whose `marbles.db` holds the tasks. */
  readonly state: string;
  /** The workspace whose tasks these are: the scope of its rows. */
  readonly workspaceId: string;
}

/**
 * A workspace's tasks and their recorded changes in the Marbles database
 * of the state root `state`, for an engine's `records`: opened on the
 * first call, under the rule a host keeps (`openHostDatabase`: made and
 * migrated only under the state root's lock, otherwise required to be
 * current), and closed with it. The handle these open is theirs: `close`,
 * which the engine calls on dispose, closes it too.
 *
 * An open that fails is tried again by the next call.
 */
export function openWorkspaceRecords(
  options: OpenWorkspaceRecordsOptions
): WorkspaceRecords {
  const database = new LazyDatabase(options);
  return new ManagedWorkspaceRecords(database, options.workspaceId, () =>
    database.close()
  );
}

/**
 * A workspace's tasks and its agent sessions over one handle on the Marbles
 * database, opened at the first call to either as `openWorkspaceRecords`
 * opens its own. Closing `records` leaves the handle open, as an engine
 * closes its records before the agents that may still write a session;
 * `close`, after the engine is disposed, closes both and the handle.
 */
export interface WorkspaceDatabase extends SideStores {
  /** The workspace's automations over the same handle. */
  readonly automations: AutomationStore;
  close(): Promise<void>;
  /** The workspace's Execution Runs over the same handle. */
  readonly executions: ExecutionStore;
  readonly records: WorkspaceRecords;
  /** The workspace's workflow Runs over the same handle. */
  readonly runs: RunStore;
  readonly sessions: ListedSessionStore;
  /** The workspace's trigger state over the same handle. */
  readonly triggers: TriggerStore;
  /** The workspace's usage facts over the same handle. */
  readonly usage: UsageStore;
}

/** `openWorkspaceRecords`, with the workspace's sessions over the same handle. */
export function openWorkspaceDatabase(
  options: OpenWorkspaceRecordsOptions
): WorkspaceDatabase {
  const database = new LazyDatabase(options);
  const records = new ManagedWorkspaceRecords(
    database,
    options.workspaceId,
    () => Promise.resolve()
  );
  const sessions = new ManagedSessionStore(database, options.workspaceId);
  const runs = new ManagedRunStore(database, options.workspaceId, () =>
    Promise.resolve()
  );
  const triggers = new ManagedTriggerStore(database, options.workspaceId, () =>
    Promise.resolve()
  );
  const usage = new ManagedUsageStore(database, options.workspaceId, () =>
    Promise.resolve()
  );
  const automations = new ManagedAutomationStore(
    database,
    options.workspaceId,
    () => Promise.resolve()
  );
  const executions = new ManagedExecutionStore(
    database,
    options.workspaceId,
    () => Promise.resolve()
  );
  const side = new RecordsGate("the workspace database is closed");
  return {
    ...sideStores(database, options.workspaceId, side),
    automations,
    async close() {
      try {
        await records.close();
        await runs.close();
        await triggers.close();
        await usage.close();
        await automations.close();
        await executions.close();
        await sessions.close();
        await side.close();
      } finally {
        await database.close();
      }
    },
    executions,
    records,
    runs,
    sessions,
    triggers,
    usage,
  };
}

/**
 * Everything an engine given `state` keeps in the database
 * `defaultStateRoot` chooses, its sessions included, over one handle
 * (`openWorkspaceDatabase`).
 */
export function defaultWorkspaceDatabase(
  state: string,
  root: string,
  workspaceId: string
): WorkspaceDatabase {
  return openWorkspaceDatabase({
    state: defaultStateRoot(state, root, workspaceId),
    workspaceId,
  });
}

/**
 * The run store an engine given `state` and no `runs` keeps its workflow
 * Runs in: the database `defaultStateRoot` chooses, over a handle of
 * its own, opened at the engine's start under the rule a host keeps and
 * closed with the store.
 */
export function defaultWorkspaceRuns(
  state: string,
  root: string,
  workspaceId: string
): RunStore {
  const database = new LazyDatabase({
    state: defaultStateRoot(state, root, workspaceId),
    workspaceId,
  });
  return new ManagedRunStore(database, workspaceId, () => database.close());
}

/**
 * The trigger store an engine given `state` and no `triggers` keeps its
 * schedules' and monitors' state in, as `defaultWorkspaceRuns` keeps runs.
 */
export function defaultWorkspaceTriggers(
  state: string,
  root: string,
  workspaceId: string
): TriggerStore {
  const database = new LazyDatabase({
    state: defaultStateRoot(state, root, workspaceId),
    workspaceId,
  });
  return new ManagedTriggerStore(database, workspaceId, () => database.close());
}

/**
 * The stores an engine keeps beside its records whose owners never close
 * them (`grants`, `approvals`, `activityStore`): what is written there
 * happens while agents run.
 */
type SideStores = Required<
  Pick<EngineOptions, "activityStore" | "approvals" | "grants">
>;

/**
 * The side stores over `database`, scoped by `workspaceId`, each built at
 * its first call once the database is open. Every call runs through
 * `gate`, which the owner of the handle closes before it closes the
 * handle: that waits for calls under way and refuses later ones, so none
 * opens the handle again.
 */
function sideStores(
  database: LazyDatabase,
  workspaceId: string,
  gate: RecordsGate
): SideStores {
  const over = <T>(make: (database: StoreDatabase) => T) => {
    const built = new OverDatabase(database, (opened) => make(opened.database));
    return <R>(call: (store: T) => Promise<R>): Promise<R> =>
      gate.run(async () => call(await built.get()));
  };
  const kept = (opened: StoreDatabase) => ({
    database: opened,
    scope: workspaceId,
  });
  const activities = over((opened) => new DatabaseActivityStore(kept(opened)));
  const approvals = over(
    (opened) => new DatabaseDeferredApprovalStore(kept(opened))
  );
  const grants = over((opened) => new DatabaseGrantStorage(kept(opened)));
  return {
    activityStore: {
      load: () => activities((store) => store.load()),
      put: (key, record) => activities((store) => store.put(key, record)),
    },
    approvals: {
      change: (update) => approvals((store) => store.change(update)),
      load: () => approvals((store) => store.load()),
    },
    grants: {
      transact: (apply) => grants((store) => store.transact(apply)),
    },
  };
}

/** What an engine keeps in the Marbles database when it is given `state`. */
type DatabaseKept = Pick<
  EngineOptions,
  | "automationStore"
  | "executionStore"
  | "records"
  | "runs"
  | "triggers"
  | "usageStore"
>;

/**
 * `options`, with each store it keeps in the Marbles database that it was
 * not handed (its tasks, workflow Runs, Execution Runs, trigger state,
 * automations and usage facts)
 * over one handle on the database `defaultStateRoot` chooses for
 * `state`, opened at the first call to any of them under the rule a host
 * keeps. The handle closes once every store made here has closed, as the
 * engine closes each on dispose; a store it was handed is left as it is.
 */
export function withWorkspaceDatabase(
  options: EngineOptions & { readonly state: string }
): EngineOptions {
  const { root, state, workspaceId } = options;
  const database = new LazyDatabase({
    state: defaultStateRoot(state, root, workspaceId),
    workspaceId,
  });
  const make: {
    readonly [K in keyof DatabaseKept]-?: (
      done: () => Promise<void>
    ) => NonNullable<DatabaseKept[K]>;
  } = {
    automationStore: (done) =>
      new ManagedAutomationStore(database, workspaceId, done),
    executionStore: (done) =>
      new ManagedExecutionStore(database, workspaceId, done),
    records: (done) => new ManagedWorkspaceRecords(database, workspaceId, done),
    runs: (done) => new ManagedRunStore(database, workspaceId, done),
    triggers: (done) => new ManagedTriggerStore(database, workspaceId, done),
    usageStore: (done) => new ManagedUsageStore(database, workspaceId, done),
  };
  const missing = (Object.keys(make) as (keyof DatabaseKept)[]).filter(
    (key) => options[key] === undefined
  );
  const side = new RecordsGate("the workspace database is closed");
  let open = missing.length;
  const release = async () => {
    open -= 1;
    if (open === 0) {
      try {
        await side.close();
      } finally {
        await database.close();
      }
    }
  };
  const sides = sideStores(database, workspaceId, side);
  return {
    ...options,
    ...Object.fromEntries(missing.map((key) => [key, make[key](release)])),
    ...(open === 0
      ? {}
      : {
          activityStore: options.activityStore ?? sides.activityStore,
          approvals: options.approvals ?? sides.approvals,
          grants: options.grants ?? sides.grants,
        }),
  };
}

/**
 * The state root whose database an engine given `state` keeps its records
 * in. When `state` is the directory Marbles itself places the workspace at
 * `root` in, under the state root above it (`<stateRoot>/<id>`, the id
 * derived from `root`, and `workspaceId` that id), it is that state root,
 * whose database the CLI and MCP read for that workspace. Otherwise it is
 * `state` itself, a database of the engine's own, `<state>/marbles.db`, so
 * nothing is written outside the directory the caller gave.
 */
function defaultStateRoot(
  state: string,
  root: string,
  workspaceId: string
): string {
  const dir = resolve(state);
  return placedByMarbles(dir, root, workspaceId) ? dirname(dir) : dir;
}

function placedByMarbles(
  dir: string,
  root: string,
  workspaceId: string
): boolean {
  let placed: Workspace;
  try {
    placed = workspaceState(dirname(dir), root);
  } catch {
    // A root that cannot be resolved is no workspace Marbles placed.
    return false;
  }
  return placed.id === workspaceId && placed.dir === dir;
}

/**
 * One writer handle on a state root's database, opened at the first call
 * under the rule a host keeps (`openHostDatabase`). An open that fails is
 * tried again by the next call.
 */
class LazyDatabase {
  readonly #options: OpenWorkspaceRecordsOptions;
  #opening: Promise<MarblesDatabase> | undefined;

  constructor(options: OpenWorkspaceRecordsOptions) {
    this.#options = options;
  }

  open(): Promise<MarblesDatabase> {
    const { state, workspaceId: _, ...options } = this.#options;
    this.#opening ??= openHostDatabase(state, options).catch(
      (error: unknown) => {
        this.#opening = undefined;
        throw error;
      }
    );
    return this.#opening;
  }

  /** Close the handle, if one was opened; a later `open` opens another. */
  async close(): Promise<void> {
    const opening = this.#opening;
    this.#opening = undefined;
    (await opening?.catch(() => undefined))?.close();
  }
}

/**
 * The value `make` builds over the database the first time it is asked
 * for, once the database is open; built again if that open failed.
 */
class OverDatabase<T> {
  readonly #database: LazyDatabase;
  readonly #make: (database: MarblesDatabase) => T;
  #built: Promise<T> | undefined;

  constructor(database: LazyDatabase, make: (database: MarblesDatabase) => T) {
    this.#database = database;
    this.#make = make;
  }

  get(): Promise<T> {
    this.#built ??= this.#database
      .open()
      .then(this.#make)
      .catch((error: unknown) => {
        this.#built = undefined;
        throw error;
      });
    return this.#built;
  }

  /** What was built, if anything was; nothing is built after this. */
  async built(): Promise<T | undefined> {
    const built = this.#built;
    this.#built = undefined;
    return await built?.catch(() => undefined);
  }
}

class ManagedWorkspaceRecords implements WorkspaceRecords {
  readonly taskStore: TaskStore;
  readonly #gate = new RecordsGate();
  readonly #listeners = new EmitListeners();
  readonly #records: OverDatabase<DatabaseWorkspaceRecords>;
  readonly #release: () => Promise<void>;

  constructor(
    database: LazyDatabase,
    workspaceId: string,
    release: () => Promise<void>
  ) {
    this.#release = release;
    this.#records = new OverDatabase(database, (opened) => {
      const records = new DatabaseWorkspaceRecords({
        database: opened.database,
        scope: workspaceId,
      });
      records.watch(() => this.#listeners.emit());
      return records;
    });
    const store = async () => (await this.#records.get()).taskStore;
    this.taskStore = {
      commit: (write) => {
        // The write as it stands now: the database may still be opening.
        let owned: TaskStoreWrite;
        try {
          owned = structuredClone(write);
        } catch (error) {
          return Promise.reject(error);
        }
        return this.#gate.run(async () => (await store()).commit(owned));
      },
      get: (id) => this.#gate.run(async () => (await store()).get(id)),
      snapshot: () => this.#gate.run(async () => (await store()).snapshot()),
      transaction: (work) =>
        this.#gate.run(async () => {
          const inner = await store();
          return inner.transaction === undefined
            ? work(inner)
            : inner.transaction(work);
        }),
    };
  }

  async close(): Promise<void> {
    await this.#gate.close();
    try {
      await (await this.#records.built())?.close();
    } finally {
      await this.#release();
    }
  }

  claimDelivery(): Promise<string | undefined> {
    return this.#gate.run(async () =>
      (await this.#records.get()).claimDelivery()
    );
  }

  deliver(id: string, hash: string): Promise<void> {
    return this.#gate.run(async () =>
      (await this.#records.get()).deliver(id, hash)
    );
  }

  latest(): Promise<number> {
    return this.#gate.run(async () => (await this.#records.get()).latest());
  }

  releaseDelivery(): Promise<void> {
    return this.#gate.run(async () =>
      (await this.#records.get()).releaseDelivery()
    );
  }

  pending(query: PendingQuery): Promise<readonly StreamItem[]> {
    return this.#gate.run(async () =>
      (await this.#records.get()).pending(query)
    );
  }

  watch(listener: () => void): () => void {
    return this.#listeners.add(listener);
  }
}

/**
 * A workspace's sessions over a `LazyDatabase`: each call waits for the
 * database to open, and `close` refuses later calls once those made have
 * settled. A commit owns its write from the call, before the open.
 */
class ManagedSessionStore implements ListedSessionStore {
  readonly #gate = new RecordsGate();
  readonly #store: OverDatabase<DatabaseSessionStore>;

  constructor(database: LazyDatabase, workspaceId: string) {
    this.#store = new OverDatabase(
      database,
      (opened) =>
        new DatabaseSessionStore({
          database: opened.database,
          scope: workspaceId,
        })
    );
  }

  close(): Promise<void> {
    return this.#gate.close();
  }

  commit(write: SessionStoreWrite): Promise<void> {
    // The write as it stands now, as the package store takes it, refused as
    // it refuses it: the database may still be opening.
    let owned: SessionStoreWrite;
    try {
      owned = capturedSessionWrite(write);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#run((store) => store.commit(owned));
  }

  getMessage(id: string): Promise<SessionMessage | null> {
    return this.#run((store) => store.getMessage(id));
  }

  getSession(id: string): Promise<SessionRecord | null> {
    return this.#run((store) => store.getSession(id));
  }

  listMessages(sessionId: string): Promise<SessionMessage[]> {
    return this.#run((store) => store.listMessages(sessionId));
  }

  stamps(): Promise<readonly SessionStamp[]> {
    return this.#run((store) => store.stamps());
  }

  transaction<T>(work: (view: SessionStore) => Promise<T>): Promise<T> {
    return this.#run((store) => store.transaction(work));
  }

  #run<T>(call: (store: DatabaseSessionStore) => Promise<T>): Promise<T> {
    return this.#gate.run(async () => call(await this.#store.get()));
  }
}

/**
 * A workspace's workflow Runs over a `LazyDatabase`: each call waits for the
 * database to open, and `close` refuses later calls once those made have
 * settled, then runs `release`.
 */
class ManagedRunStore implements RunStore {
  readonly durable = true;
  readonly #gate = new RecordsGate("the run store is closed");
  readonly #release: () => Promise<void>;
  readonly #store: OverDatabase<DatabaseRunStore>;

  constructor(
    database: LazyDatabase,
    workspaceId: string,
    release: () => Promise<void>
  ) {
    this.#release = release;
    this.#store = new OverDatabase(
      database,
      (opened) =>
        new DatabaseRunStore({
          database: opened.database,
          scope: workspaceId,
        })
    );
  }

  claim(runId: string, when: ClaimCondition): Promise<boolean> {
    return this.#run((store) => store.claim(runId, when));
  }

  async close(): Promise<void> {
    await this.#gate.close();
    try {
      await (await this.#store.built())?.close();
    } finally {
      await this.#release();
    }
  }

  open(
    recorded: (runId: string) => RecordedScope | undefined,
    follows?: RunFollower
  ): Promise<WorkflowStore> {
    return this.#run((store) => store.open(recorded, follows));
  }

  recorded(runId: string): Promise<StoredScope> {
    return this.#run((store) => store.recorded(runId));
  }

  release(runId?: string): Promise<void> {
    return this.#run((store) => store.release(runId));
  }

  remove(runId: string): Promise<void> {
    return this.#run((store) => store.remove(runId));
  }

  #run<T>(call: (store: DatabaseRunStore) => Promise<T>): Promise<T> {
    return this.#gate.run(async () => call(await this.#store.get()));
  }
}

/**
 * A workspace's trigger state over a `LazyDatabase`, as `ManagedRunStore`
 * keeps its runs.
 */
class ManagedTriggerStore implements TriggerStore {
  readonly #gate = new RecordsGate("the trigger store is closed");
  readonly #release: () => Promise<void>;
  readonly #store: OverDatabase<DatabaseTriggerStore>;

  constructor(
    database: LazyDatabase,
    workspaceId: string,
    release: () => Promise<void>
  ) {
    this.#release = release;
    this.#store = new OverDatabase(
      database,
      (opened) =>
        new DatabaseTriggerStore({
          database: opened.database,
          scope: workspaceId,
        })
    );
  }

  claimTick(key: string): Promise<TickClaim> {
    return this.#run((store) => store.claimTick(key));
  }

  clearPendingLaunch(key: string): Promise<void> {
    return this.#run((store) => store.clearPendingLaunch(key));
  }

  async close(): Promise<void> {
    await this.#gate.close();
    try {
      await (await this.#store.built())?.close();
    } finally {
      await this.#release();
    }
  }

  finishTick(key: string, tick?: ScheduleHistory): Promise<void> {
    return this.#run((store) => store.finishTick(key, tick));
  }

  lastTick(key: string): Promise<ScheduleHistory | undefined> {
    return this.#run((store) => store.lastTick(key));
  }

  monitorState(key: string): Promise<MonitorState | undefined> {
    return this.#run((store) => store.monitorState(key));
  }

  saveMonitorState(key: string, state: MonitorState): Promise<void> {
    return this.#run((store) => store.saveMonitorState(key, state));
  }

  #run<T>(call: (store: DatabaseTriggerStore) => Promise<T>): Promise<T> {
    return this.#gate.run(async () => call(await this.#store.get()));
  }
}

/**
 * A workspace's usage facts over a `LazyDatabase`: each call waits for the
 * database to open, and `close` refuses later calls once those made have
 * settled. A fact is owned from the call, before the open.
 */
class ManagedUsageStore implements UsageStore {
  readonly #gate = new RecordsGate("the usage store is closed");
  readonly #release: () => Promise<void>;
  readonly #store: OverDatabase<DatabaseUsageStore>;

  constructor(
    database: LazyDatabase,
    workspaceId: string,
    release: () => Promise<void>
  ) {
    this.#release = release;
    this.#store = new OverDatabase(
      database,
      (opened) =>
        new DatabaseUsageStore({
          database: opened.database,
          scope: workspaceId,
        })
    );
  }

  async close(): Promise<void> {
    await this.#gate.close();
    try {
      await (await this.#store.built())?.close();
    } finally {
      await this.#release();
    }
  }

  facts(): Promise<{
    readonly facts: readonly StoredUsage[];
    readonly revision: number;
  }> {
    return this.#run((store) => store.facts());
  }

  mark(marker: RecordedUsageFact): Promise<void> {
    return this.#owning(marker, (store, owned) => store.mark(owned));
  }

  revision(): Promise<number> {
    return this.#run((store) => store.revision());
  }

  save(fact: RecordedUsageFact): Promise<void> {
    return this.#owning(fact, (store, owned) => store.save(owned));
  }

  /** `call` on a copy of `fact` taken now: the database may still be opening. */
  #owning(
    fact: RecordedUsageFact,
    call: (store: DatabaseUsageStore, owned: RecordedUsageFact) => Promise<void>
  ): Promise<void> {
    let owned: RecordedUsageFact;
    try {
      owned = storedUsageFact(fact);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#run((store) => call(store, owned));
  }

  #run<T>(call: (store: DatabaseUsageStore) => Promise<T>): Promise<T> {
    return this.#gate.run(async () => call(await this.#store.get()));
  }
}

/**
 * A workspace's automations over a `LazyDatabase`, as `ManagedUsageStore`
 * keeps its facts: a record put is owned from the call, before the open.
 */
class ManagedAutomationStore implements AutomationStore {
  readonly #gate = new RecordsGate("the automation store is closed");
  readonly #release: () => Promise<void>;
  readonly #store: OverDatabase<DatabaseAutomationStore>;

  constructor(
    database: LazyDatabase,
    workspaceId: string,
    release: () => Promise<void>
  ) {
    this.#release = release;
    this.#store = new OverDatabase(
      database,
      (opened) =>
        new DatabaseAutomationStore({
          database: opened.database,
          scope: workspaceId,
        })
    );
  }

  async close(): Promise<void> {
    await this.#gate.close();
    try {
      await (await this.#store.built())?.close();
    } finally {
      await this.#release();
    }
  }

  edit<T>(work: (view: AutomationView) => Promise<T>): Promise<T> {
    return this.#run((store) => store.edit(work));
  }

  list(): Promise<readonly StoredAutomation[]> {
    return this.#run((store) => store.list());
  }

  put(record: AutomationRecord): Promise<void> {
    let owned: AutomationRecord;
    try {
      owned = storedAutomation(record);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#run((store) => store.put(owned));
  }

  remove(id: string): Promise<void> {
    return this.#run((store) => store.remove(id));
  }

  #run<T>(call: (store: DatabaseAutomationStore) => Promise<T>): Promise<T> {
    return this.#gate.run(async () => call(await this.#store.get()));
  }
}

/**
 * A workspace's Execution Runs over a `LazyDatabase`, as
 * `ManagedUsageStore` keeps its facts: what a write is handed is owned from
 * the call, before the open.
 */
class ManagedExecutionStore implements ExecutionStore {
  readonly #gate = new RecordsGate("the execution store is closed");
  readonly #release: () => Promise<void>;
  readonly #store: OverDatabase<DatabaseExecutionStore>;

  constructor(
    database: LazyDatabase,
    workspaceId: string,
    release: () => Promise<void>
  ) {
    this.#release = release;
    this.#store = new OverDatabase(
      database,
      (opened) =>
        new DatabaseExecutionStore({
          database: opened.database,
          scope: workspaceId,
        })
    );
  }

  async close(): Promise<void> {
    await this.#gate.close();
    try {
      await (await this.#store.built())?.close();
    } finally {
      await this.#release();
    }
  }

  get(id: string): Promise<StoredExecution | undefined> {
    return this.#run((store) => store.get(id));
  }

  gaps(): Promise<readonly RetentionGap[]> {
    return this.#run((store) => store.gaps());
  }

  list(): Promise<readonly StoredExecution[]> {
    return this.#run((store) => store.list());
  }

  advise(
    id: string,
    change: { readonly progress: JsonValue; readonly updatedAt: string }
  ): Promise<Written> {
    return this.#owning(
      change,
      (value) => ({
        progress: storedProgress(id, value.progress),
        updatedAt: value.updatedAt,
      }),
      (store, owned) => store.advise(id, owned)
    );
  }

  create(run: ExecutionRun): Promise<boolean> {
    return this.#owning(run, storedExecutionRun, (store, owned) =>
      store.create(owned)
    );
  }

  observe(
    id: string,
    observation: ExecutionObservation,
    updatedAt: string
  ): Promise<Written> {
    return this.#owning(
      observation,
      (value) => storedObservation(id, value),
      (store, owned) => store.observe(id, owned, updatedAt)
    );
  }

  transition(id: string, change: LifecycleChange): Promise<Written> {
    return this.#owning(
      change,
      (value) => storedChange(id, value),
      (store, owned) => store.transition(id, owned)
    );
  }

  putGap(gap: RetentionGap): Promise<void> {
    return this.#owning(gap, storedRetentionGap, (store, owned) =>
      store.putGap(owned)
    );
  }

  remove(id: string): Promise<void> {
    return this.#run((store) => store.remove(id));
  }

  transaction<T>(work: (view: ExecutionView) => Promise<T>): Promise<T> {
    return this.#run((store) => store.transaction(work));
  }

  withSource(
    name: string,
    source: string
  ): Promise<StoredExecution | undefined> {
    return this.#run((store) => store.withSource(name, source));
  }

  /** `call` on the stored form of `value` taken now: the database may still be opening. */
  #owning<V, T>(
    value: V,
    stored: (value: V) => V,
    call: (store: DatabaseExecutionStore, owned: V) => Promise<T>
  ): Promise<T> {
    let owned: V;
    try {
      owned = stored(value);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#run((store) => call(store, owned));
  }

  #run<T>(call: (store: DatabaseExecutionStore) => Promise<T>): Promise<T> {
    return this.#gate.run(async () => call(await this.#store.get()));
  }
}
