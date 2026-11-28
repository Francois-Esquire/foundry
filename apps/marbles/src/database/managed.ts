import { dirname, resolve } from "node:path";
import type { SessionMessage, SessionRecord } from "@foundry/agents/session";
import type { SessionStore, SessionStoreWrite } from "@foundry/agents/store";
import { capturedSessionWrite } from "@foundry/agents/store/sqlite";
import type { AuthorizationStore } from "@foundry/authorization/store";
import { SqliteAuthorizationStore } from "@foundry/authorization/store/sqlite";
import type { JsonValue } from "@foundry/lib/json";
import { ownedWrite } from "@foundry/lib/plain-json";
import type { QueueStoreService } from "@foundry/queue/store";
import type { ScheduleStoreService } from "@foundry/scheduling/store";
import type { TaskStore, TaskStoreWrite } from "@foundry/tasks";
import { DatabaseActivityStore } from "~/database/activities";
import { DatabaseAutomationStore } from "~/database/automations";
import { surfacingBusy } from "~/database/busy";
import { ChangeRecorder } from "~/database/changes";
import { DatabaseExecutionStore } from "~/database/executions";
import type { HostDatabaseOptions, MarblesDatabase } from "~/database/open";
import { openHostDatabase } from "~/database/open";
import { DatabaseRecoveryLog } from "~/database/recoveries";
import { DatabaseRunStore } from "~/database/runs";
import { DatabaseSessionStore } from "~/database/sessions";
import { DatabaseWorkspaceRecords } from "~/database/tasks";
import { DatabaseTriggerStore } from "~/database/triggers";
import type { StoreDatabase } from "~/database/types";
import { DatabaseUsageStore } from "~/database/usage";
import { NODE_OWNER_LIVENESS } from "~/host/liveness";
import type { AutomationRecord } from "~/lib/automation";
import type {
  AutomationStore,
  AutomationView,
  StoredAutomation,
} from "~/lib/automation/store";
import { storedAutomation } from "~/lib/automation/store";
import type { EngineOptions } from "~/lib/engine";
import type { ChangeLog } from "~/lib/events/log";
import type { WorkspaceRecords } from "~/lib/events/records";
import { causingRun } from "~/lib/events/records";
import { RecordsGate } from "~/lib/events/records-gate";
import type {
  ExecutionObservation,
  RetentionGap,
  StoredAnnex,
} from "~/lib/executions/record";
import type { ExecutionStore, Removal } from "~/lib/executions/store";
import { storedObservation, storedProgress } from "~/lib/executions/store";
import type { RecordedScope } from "~/lib/runs/scope";
import type { RunStore, StoredScope } from "~/lib/runs/store";
import type { MonitorState, TriggerStore } from "~/lib/schedule/store";
import { gatedScheduleStore } from "~/lib/schedule/store";
import { inTurn } from "~/lib/shared/in-turn";
import type { RecordedUsageFact } from "~/lib/usage";
import type { ListedSessionStore, SessionStamp } from "~/lib/usage/evidence";
import type { StoredUsage, UsageStore } from "~/lib/usage/store";
import { storedUsageFact } from "~/lib/usage/store";
import type { Workspace } from "~/state/workspace";
import { workspaceState } from "~/state/workspace";

export interface OpenWorkspaceRecordsOptions extends HostDatabaseOptions {
  readonly state: string;
  readonly workspaceId: string;
}

export function openWorkspaceRecords(
  options: OpenWorkspaceRecordsOptions
): WorkspaceRecords {
  const database = new LazyDatabase(options);
  return new ManagedWorkspaceRecords(
    database,
    new ChangeRecorder(options.workspaceId, {
      causingRun: () => causingRun() ?? undefined,
    }),
    () => database.close()
  );
}

export interface WorkspaceDatabase extends SideStores {
  readonly automations: AutomationStore;
  close(): Promise<void>;
  readonly executions: ExecutionStore;
  readonly records: WorkspaceRecords;
  readonly runs: RunStore;
  readonly sessions: ListedSessionStore;
  readonly triggers: TriggerStore;
  readonly usage: UsageStore;
}

export function openWorkspaceDatabase(
  options: OpenWorkspaceRecordsOptions
): WorkspaceDatabase {
  const database = new LazyDatabase(options);
  const changes = new ChangeRecorder(options.workspaceId, {
    causingRun: () => causingRun() ?? undefined,
  });
  const records = new ManagedWorkspaceRecords(database, changes, () =>
    Promise.resolve()
  );
  const sessions = new ManagedSessionStore(database, changes);
  const runs = new ManagedRunStore(database, changes, () => Promise.resolve());
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
  let closing: Promise<void> | undefined;
  const shutDown = async () => {
    const closed = await Promise.allSettled([
      records.close(),
      runs.close(),
      triggers.close(),
      usage.close(),
      automations.close(),
      executions.close(),
      sessions.close(),
      side.close(),
    ]);
    const errors = closed.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    try {
      await database.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "Failed to close the workspace's database"
      );
    }
  };
  return {
    ...sideStores(database, options.workspaceId, side),
    automations,
    close() {
      closing ??= shutDown();
      return closing;
    },
    executions,
    records,
    runs,
    sessions,
    triggers,
    usage,
  };
}

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

export function defaultWorkspaceRuns(
  state: string,
  root: string,
  workspaceId: string
): RunStore {
  const database = new LazyDatabase({
    state: defaultStateRoot(state, root, workspaceId),
    workspaceId,
  });
  return new ManagedRunStore(
    database,
    new ChangeRecorder(workspaceId, {
      causingRun: () => causingRun() ?? undefined,
    }),
    () => database.close()
  );
}

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

type SideStores = Required<
  Pick<EngineOptions, "activityStore" | "authorizationStore" | "recoveryLog">
>;

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
  const authorization = over((opened) =>
    surfacingBusy(new SqliteAuthorizationStore(kept(opened)))
  );
  const recoveries = over((opened) => new DatabaseRecoveryLog(kept(opened)));
  const authorizationStore: AuthorizationStore = {
    commit: (write) => authorization((store) => store.commit(write)),
    durability: "commit",
    getClaim: (invocationId) =>
      authorization((store) => store.getClaim(invocationId)),
    getGrant: (id) => authorization((store) => store.getGrant(id)),
    getRestriction: (id) => authorization((store) => store.getRestriction(id)),
    listGrants: (query) => authorization((store) => store.listGrants(query)),
    listRestrictions: () => authorization((store) => store.listRestrictions()),
    transaction: (work) => authorization((store) => store.transaction(work)),
  };
  return {
    activityStore: {
      load: () => activities((store) => store.load()),
      put: (key, record) => activities((store) => store.put(key, record)),
    },
    authorizationStore,
    recoveryLog: {
      record: (report) => recoveries((store) => store.record(report)),
    },
  };
}

type DatabaseKept = Pick<
  EngineOptions,
  | "automationStore"
  | "executionStore"
  | "records"
  | "runs"
  | "triggers"
  | "usageStore"
>;

export interface WorkspaceDatabaseOptions {
  readonly options: EngineOptions;
  release(): Promise<void>;
}

export function withWorkspaceDatabase(
  options: EngineOptions & { readonly state: string }
): WorkspaceDatabaseOptions {
  const { root, state, workspaceId } = options;
  const database = new LazyDatabase({
    state: defaultStateRoot(state, root, workspaceId),
    workspaceId,
  });
  const changes = new ChangeRecorder(workspaceId, {
    causingRun: () => causingRun() ?? undefined,
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
    records: (done) => new ManagedWorkspaceRecords(database, changes, done),
    runs: (done) => new ManagedRunStore(database, changes, done),
    triggers: (done) => new ManagedTriggerStore(database, workspaceId, done),
    usageStore: (done) => new ManagedUsageStore(database, workspaceId, done),
  };
  const missing = (Object.keys(make) as (keyof DatabaseKept)[]).filter(
    (key) => options[key] === undefined
  );
  const side = new RecordsGate("the workspace database is closed");
  let open = 0;
  const claim = (): (() => Promise<void>) => {
    open += 1;
    let released: Promise<void> | undefined;
    return () => {
      released ??= (async () => {
        open -= 1;
        if (open === 0) {
          await inTurn(
            () => side.close(),
            () => database.close(),
            "Failed to close the workspace's database"
          );
        }
      })();
      return released;
    };
  };
  const sides = sideStores(database, workspaceId, side);
  return {
    options: {
      ...options,
      ...Object.fromEntries(missing.map((key) => [key, make[key](claim())])),
      activityStore: options.activityStore ?? sides.activityStore,
      authorizationStore:
        options.authorizationStore ?? sides.authorizationStore,
      recoveryLog: options.recoveryLog ?? sides.recoveryLog,
    },
    release: claim(),
  };
}

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
    return false;
  }
  return placed.id === workspaceId && placed.dir === dir;
}

class LazyDatabase {
  readonly #options: OpenWorkspaceRecordsOptions;
  #opening: Promise<MarblesDatabase> | undefined;
  #closed: Promise<void> = Promise.resolve();

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

  close(): Promise<void> {
    const opening = this.#opening;
    this.#opening = undefined;
    const before = this.#closed;
    this.#closed = (async () => {
      await before;
      (await settledOpen(opening))?.close();
    })();
    return this.#closed;
  }
}

async function settledOpen(
  opening: Promise<MarblesDatabase> | undefined
): Promise<MarblesDatabase | undefined> {
  return await opening?.catch(() => undefined);
}

class OverDatabase<T> {
  readonly #database: LazyDatabase;
  readonly #make: (database: MarblesDatabase) => T;
  #built: Promise<T> | undefined;
  #taken: Promise<T | undefined> | undefined;

  constructor(database: LazyDatabase, make: (database: MarblesDatabase) => T) {
    this.#database = database;
    this.#make = make;
  }

  get(): Promise<T> {
    if (this.#taken !== undefined) {
      return Promise.reject(new Error("the workspace database is closed"));
    }
    this.#built ??= this.#database
      .open()
      .then(this.#make)
      .catch((error: unknown) => {
        this.#built = undefined;
        throw error;
      });
    return this.#built;
  }

  built(): Promise<T | undefined> {
    this.#taken ??= (async () => await this.#built?.catch(() => undefined))();
    return this.#taken;
  }
}

class ManagedWorkspaceRecords implements WorkspaceRecords {
  readonly taskStore: TaskStore;
  readonly log: ChangeLog;
  readonly #gate = new RecordsGate();
  readonly #changes: ChangeRecorder;
  readonly #records: OverDatabase<DatabaseWorkspaceRecords>;
  readonly #release: () => Promise<void>;
  #closing: Promise<void> | undefined;

  constructor(
    database: LazyDatabase,
    changes: ChangeRecorder,
    release: () => Promise<void>
  ) {
    this.#release = release;
    this.#changes = changes;
    this.#records = new OverDatabase(
      database,
      (opened) =>
        new DatabaseWorkspaceRecords({
          changes,
          database: opened.database,
          liveness: NODE_OWNER_LIVENESS,
          scope: changes.scope,
        })
    );
    const log = async () => (await this.#records.get()).log;
    this.log = {
      compact: (bound) =>
        this.#gate.run(async () => (await log()).compact(bound)),
      declare: (key, now) =>
        this.#gate.run(async () => (await log()).declare(key, now)),
      fail: (key, failure) =>
        this.#gate.run(async () => (await log()).fail(key, failure)),
      head: () => this.#gate.run(async () => (await log()).head()),
      move: (key, move) =>
        this.#gate.run(async () => (await log()).move(key, move)),
      observers: () => this.#gate.run(async () => (await log()).observers()),
      read: (query) => this.#gate.run(async () => (await log()).read(query)),
      unstick: (key) => this.#gate.run(async () => (await log()).unstick(key)),
    };
    const store = async () => (await this.#records.get()).taskStore;
    this.taskStore = {
      children: (parentId) =>
        this.#gate.run(async () => {
          const inner = await store();
          return inner.children === undefined
            ? (await inner.snapshot()).tasks.filter(
                (task) => task.parentId === parentId
              )
            : inner.children(parentId);
        }),
      commit: (write) => {
        let owned: TaskStoreWrite;
        try {
          owned = ownedWrite(write);
        } catch (error) {
          return Promise.reject(error);
        }
        return this.#gate.run(async () => (await store()).commit(owned));
      },
      dependenciesOf: (ids) =>
        this.#gate.run(async () => {
          const inner = await store();
          if (inner.dependenciesOf !== undefined) {
            return inner.dependenciesOf(ids);
          }
          const wanted = new Set(ids);
          return (await inner.snapshot()).dependencies.filter(
            (edge) => wanted.has(edge.taskId) || wanted.has(edge.dependsOnId)
          );
        }),
      get: (id) => this.#gate.run(async () => (await store()).get(id)),
      list: (query) =>
        this.#gate.run(async () => {
          const inner = await store();
          if (inner.list !== undefined) {
            return inner.list(query);
          }
          return (await inner.snapshot()).tasks.filter(
            (task) =>
              (query?.status === undefined || task.status === query.status) &&
              (query?.parentId === undefined ||
                task.parentId === query.parentId)
          );
        }),
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

  close(): Promise<void> {
    this.#closing ??= this.#shutDown();
    return this.#closing;
  }

  async #shutDown(): Promise<void> {
    await this.#gate.close();
    await inTurn(
      async () => {
        await (await this.#records.built())?.close();
      },
      () => this.#release(),
      "Failed to close a store and give up its database"
    );
  }

  claimDelivery(): Promise<string | undefined> {
    return this.#gate.run(async () =>
      (await this.#records.get()).claimDelivery()
    );
  }

  releaseDelivery(): Promise<void> {
    return this.#gate.run(async () =>
      (await this.#records.get()).releaseDelivery()
    );
  }

  watch(listener: () => void): () => void {
    return this.#changes.watch(listener);
  }
}

class ManagedSessionStore implements ListedSessionStore {
  readonly #gate = new RecordsGate();
  #closing: Promise<void> | undefined;
  readonly #store: OverDatabase<DatabaseSessionStore>;

  constructor(database: LazyDatabase, changes: ChangeRecorder) {
    this.#store = new OverDatabase(
      database,
      (opened) =>
        new DatabaseSessionStore({
          changes,
          database: opened.database,
          scope: changes.scope,
        })
    );
  }

  close(): Promise<void> {
    this.#closing ??= this.#gate.close();
    return this.#closing;
  }

  commit(write: SessionStoreWrite): Promise<void> {
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

class ManagedRunStore implements RunStore {
  readonly durable = true;
  readonly #gate = new RecordsGate("the run store is closed");
  readonly #release: () => Promise<void>;
  #closing: Promise<void> | undefined;
  readonly #store: OverDatabase<DatabaseRunStore>;

  constructor(
    database: LazyDatabase,
    changes: ChangeRecorder,
    release: () => Promise<void>
  ) {
    this.#release = release;
    this.#store = new OverDatabase(
      database,
      (opened) =>
        new DatabaseRunStore({
          changes,
          database: opened.database,
          scope: changes.scope,
        })
    );
  }

  close(): Promise<void> {
    this.#closing ??= this.#shutDown();
    return this.#closing;
  }

  async #shutDown(): Promise<void> {
    await this.#gate.close();
    await inTurn(
      async () => {
        await (await this.#store.built())?.close();
      },
      () => this.#release(),
      "Failed to close a store and give up its database"
    );
  }

  open(
    recorded: (runId: string) => RecordedScope | undefined
  ): Promise<QueueStoreService> {
    return this.#run((store) => store.open(recorded));
  }

  recorded(runId: string): Promise<StoredScope> {
    return this.#run((store) => store.recorded(runId));
  }

  #run<T>(call: (store: DatabaseRunStore) => Promise<T>): Promise<T> {
    return this.#gate.run(async () => call(await this.#store.get()));
  }
}

class ManagedTriggerStore implements TriggerStore {
  readonly #gate = new RecordsGate("the trigger store is closed");
  readonly #release: () => Promise<void>;
  #closing: Promise<void> | undefined;
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

  clearPendingLaunch(key: string): Promise<void> {
    return this.#run((store) => store.clearPendingLaunch(key));
  }

  close(): Promise<void> {
    this.#closing ??= this.#shutDown();
    return this.#closing;
  }

  async #shutDown(): Promise<void> {
    await this.#gate.close();
    await inTurn(
      async () => {
        await (await this.#store.built())?.close();
      },
      () => this.#release(),
      "Failed to close a store and give up its database"
    );
  }

  forgetMonitor(key: string): Promise<void> {
    return this.#run((store) => store.forgetMonitor(key));
  }

  monitorState(key: string): Promise<MonitorState | undefined> {
    return this.#run((store) => store.monitorState(key));
  }

  saveMonitorState(key: string, state: MonitorState): Promise<void> {
    return this.#run((store) => store.saveMonitorState(key, state));
  }

  async schedules(): Promise<ScheduleStoreService> {
    return gatedScheduleStore(
      await this.#run((store) => store.schedules()),
      (call) => this.#gate.run(call)
    );
  }

  #run<T>(call: (store: DatabaseTriggerStore) => Promise<T>): Promise<T> {
    return this.#gate.run(async () => call(await this.#store.get()));
  }
}

class ManagedUsageStore implements UsageStore {
  readonly #gate = new RecordsGate("the usage store is closed");
  readonly #release: () => Promise<void>;
  #closing: Promise<void> | undefined;
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

  close(): Promise<void> {
    this.#closing ??= this.#shutDown();
    return this.#closing;
  }

  async #shutDown(): Promise<void> {
    await this.#gate.close();
    await inTurn(
      async () => {
        await (await this.#store.built())?.close();
      },
      () => this.#release(),
      "Failed to close a store and give up its database"
    );
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

class ManagedAutomationStore implements AutomationStore {
  readonly #gate = new RecordsGate("the automation store is closed");
  readonly #release: () => Promise<void>;
  #closing: Promise<void> | undefined;
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

  close(): Promise<void> {
    this.#closing ??= this.#shutDown();
    return this.#closing;
  }

  async #shutDown(): Promise<void> {
    await this.#gate.close();
    await inTurn(
      async () => {
        await (await this.#store.built())?.close();
      },
      () => this.#release(),
      "Failed to close a store and give up its database"
    );
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

class ManagedExecutionStore implements ExecutionStore {
  readonly #gate = new RecordsGate("the execution store is closed");
  readonly #release: () => Promise<void>;
  #closing: Promise<void> | undefined;
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

  close(): Promise<void> {
    this.#closing ??= this.#shutDown();
    return this.#closing;
  }

  async #shutDown(): Promise<void> {
    await this.#gate.close();
    await inTurn(
      async () => {
        await (await this.#store.built())?.close();
      },
      () => this.#release(),
      "Failed to close a store and give up its database"
    );
  }

  get(id: string): Promise<StoredAnnex | undefined> {
    return this.#run((store) => store.get(id));
  }

  gaps(): Promise<readonly RetentionGap[]> {
    return this.#run((store) => store.gaps());
  }

  list(): Promise<readonly StoredAnnex[]> {
    return this.#run((store) => store.list());
  }

  observe(
    id: string,
    observation: ExecutionObservation,
    updatedAt: string
  ): Promise<void> {
    return this.#owning(
      observation,
      (value) => storedObservation(id, value),
      (store, owned) => store.observe(id, owned, updatedAt)
    );
  }

  progress(id: string, progress: JsonValue, updatedAt: string): Promise<void> {
    return this.#owning(
      progress,
      (value) => storedProgress(id, value),
      (store, owned) => store.progress(id, owned, updatedAt)
    );
  }

  remove(
    ids: readonly string[],
    removals: readonly Removal[],
    updatedAt: string
  ): Promise<readonly RetentionGap[]> {
    return this.#run((store) => store.remove(ids, removals, updatedAt));
  }

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
