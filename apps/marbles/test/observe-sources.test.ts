import { basename, join } from "node:path";
import { Sessions } from "@foundry/agents/session";
import type { SessionStore } from "@foundry/agents/store";
import { SqliteSessionStore } from "@foundry/agents/store/sqlite";
import { Artifacts } from "@foundry/artifacts";
import type { ArtifactStore } from "@foundry/artifacts/store";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import type { QueueEvent, Run } from "@foundry/queue";
import type { QueueStoreService, QueueWrite } from "@foundry/queue/store";
import { makeSqliteQueueStore } from "@foundry/queue/store/sqlite";
import { createContainers } from "@foundry/sandbox/node";
import type { ContainerStore } from "@foundry/sandbox/store";
import { SqliteContainerStore } from "@foundry/sandbox/store/sqlite";
import { createFakeDriver } from "@foundry/sandbox/testing";
import type { TaskStore } from "@foundry/tasks";
import { Tasks } from "@foundry/tasks";
import { SqliteTaskStore } from "@foundry/tasks/store/sqlite";
import type { WorkspaceId } from "@foundry/workspaces";
import { WorkspaceCatalog } from "@foundry/workspaces";
import type { WorkspaceStore } from "@foundry/workspaces/store";
import { SqliteWorkspaceStore } from "@foundry/workspaces/store/sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Catalog } from "~/authoring/catalog";
import { createEngine } from "~/create";
import { DatabaseRunStore } from "~/database/runs";
import { DatabaseSessionStore } from "~/database/sessions";
import { workspaceStores } from "~/database/stores";
import { DELIVERY_POLL_MS, Delivery } from "~/lib/events/delivery";
import type { Fact, Source } from "~/lib/events/source";
import {
  ARTIFACTS,
  RUNS,
  SANDBOXES,
  SESSIONS,
  TASKS,
  WORKSPACES,
} from "~/lib/events/source";
import { current } from "~/lib/run-scope";
import { readRun, runStoreEffect } from "~/lib/workflow-runs";
import { testEngine } from "./helpers/engine";
import { putRun } from "./helpers/queue-runs";
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";

let machine: TestMachine;

beforeAll(async () => {
  machine = await testMachine();
});

afterAll(() => {
  machine.close();
});

const PROBED: Run = {
  attempt: 1,
  id: "rn-probed",
  jobId: "jb-probed",
  pool: "marbles",
  revision: 0,
  state: { availableAt: 0, kind: "queued", queuedAt: 0 },
};

function probedRuns(write: { readonly events: readonly Fact[] }): QueueWrite {
  return {
    events: write.events.map(
      (fact): QueueEvent => ({
        at: Date.parse(fact.at),
        id: fact.id,
        run: PROBED,
        type: "run.queued",
      })
    ),
  };
}

function promised(store: QueueStoreService) {
  return {
    commit: (write: QueueWrite) => runStoreEffect(store.commit(write)),
    store,
  };
}

const SOURCES: readonly (readonly [string, Source])[] = [
  ["artifacts", ARTIFACTS],
  ["runs", RUNS],
  ["sandboxes", SANDBOXES],
  ["sessions", SESSIONS],
  ["tasks", TASKS],
  ["workspaces", WORKSPACES],
];

describe("observing every source", () => {
  it("hands each observer the facts its source's domain class built, in commit order, and nothing of another source", async () => {
    const state = machine.workspace();
    const scope = basename(state);
    const records = machine.records(state);
    const { changes } = records;
    const { database } = machine.database;
    const stores = workspaceStores(database, scope, { changes });
    const sessionStore = new DatabaseSessionStore({
      changes,
      database,
      scope,
    });
    const runStore = new DatabaseRunStore({ changes, database, scope });

    const seen = new Map<string, string[]>();
    const delivery = new Delivery({ print: () => undefined, records });
    for (const [key, source] of SOURCES) {
      seen.set(key, []);
      delivery.observe(
        source,
        (fact: Fact) => {
          seen.get(key)?.push(fact.type);
        },
        { name: `every-${key}` }
      );
    }
    const unwatch = records.watch(() => delivery.wake());
    await delivery.start();

    await new Tasks({ store: records.taskStore }).create({ title: "Task" });
    const artifacts = new Artifacts({ store: stores.artifacts });
    await artifacts.create({
      entries: { "a.md": { bytes: "# A" } },
      name: "Notes",
      type: "text/markdown",
    });
    const containers = createContainers({
      driver: createFakeDriver() as never,
      instanceLabel: "marbles-test",
      store: stores.containers,
    });
    const sandbox = await containers.start({
      image: "docker.io/oven/bun:1",
    });
    await sandbox.close();
    await containers.shutdown();
    await new Sessions({ store: sessionStore }).createSession({ id: "s1" });
    await putRun(
      await runStore.open(() => undefined),
      "rn-observed",
      "running",
      {
        step: "s",
      }
    );
    const now = new Date();
    await new WorkspaceCatalog(stores.workspaces, () => undefined).create({
      entries: [],
      workspace: {
        createdAt: now,
        id: crypto.randomUUID() as WorkspaceId,
        lastReconciledAt: now,
        name: "alpha",
        source: { kind: "host", path: "/src/alpha", sourceId: null },
        updatedAt: now,
      },
    });

    const expected = {
      artifacts: expect.arrayContaining(["artifact.created"]),
      runs: ["run.queued", "run.started"],
      sandboxes: expect.arrayContaining(["sandbox.created"]),
      sessions: ["session.created"],
      tasks: ["tasks.changed"],
      workspaces: ["workspace.created"],
    };
    await vi.waitFor(() => expect(Object.fromEntries(seen)).toEqual(expected), {
      timeout: DELIVERY_POLL_MS * 5,
    });
    unwatch();
    await delivery.stop();

    const logged = await machine.changes(state);
    expect(logged.map((change) => change.position)).toEqual(
      logged.map((_, index) => index + 1)
    );
    expect(new Set(logged.map((change) => change.source))).toEqual(
      new Set(SOURCES.map(([key]) => key))
    );
    for (const change of logged) {
      expect(change.type).toBe(change.payload.type);
      expect(change.id).toBe(change.payload.id);
      expect(change.runId).toBeNull();
    }
    const head = logged.at(-1)?.position;
    for (const observer of await records.log.observers()) {
      expect(observer.position, observer.name).toBe(head);
    }
    await records.close();
    await runStore.close();
  });
});

describe("an engine that does not record a source", () => {
  it("says at build which observers it hands nothing", async () => {
    const catalog = new Catalog();
    catalog.observe({
      handler: () => undefined,
      name: "notes",
      source: ARTIFACTS,
    });
    catalog.observe({ handler: () => undefined, name: "todo", source: TASKS });
    const lines: string[] = [];
    const engine = createEngine({
      artifacts: machine.root,
      catalog,
      dry: true,
      print: (line) => lines.push(line),
      providers: [],
      root: machine.root,
      stateRoot: machine.root,
      workspaceId: "dry",
    });
    await engine.dispose();
    expect(lines.filter((line) => line.startsWith("[observe]"))).toEqual([
      "[observe] notes (artifacts) receives nothing here: this engine keeps its artifacts without recording their changes",
    ]);
  }, 30_000);
});

describe("the run a fact is recorded as made by", () => {
  it("is the run the write was handed in, through every store's hook, from its events read once", async () => {
    const state = machine.workspace();
    const scope = basename(state);
    const records = machine.records(state);
    const { changes } = records;
    const { database } = machine.database;
    const stores = workspaceStores(database, scope, { changes });
    const runStore = new DatabaseRunStore({ changes, database, scope });
    const committers: readonly (readonly [
      string,
      (write: { readonly events: readonly Fact[] }) => Promise<void>,
    ])[] = [
      ["tasks", (write) => records.taskStore.commit(write as never)],
      ["artifacts", (write) => stores.artifacts.commit(write as never)],
      ["sandboxes", (write) => stores.containers.commit(write as never)],
      [
        "workspaces",
        (write) =>
          stores.workspaces.commit(
            Object.assign(write, {
              removeWorkspace: crypto.randomUUID(),
            }) as never
          ),
      ],
      [
        "sessions",
        (write) =>
          new DatabaseSessionStore({ changes, database, scope }).commit(
            write as never
          ),
      ],
      [
        "runs",
        async (write) =>
          runStoreEffect(
            (await runStore.open(() => undefined)).commit(probedRuns(write))
          ),
      ],
    ];
    const reads = new Map<string, number>();
    for (const [source, commit] of committers) {
      reads.set(source, 0);
      const write = {
        get events(): readonly Fact[] {
          const read = (reads.get(source) ?? 0) + 1;
          reads.set(source, read);
          return [
            {
              at: new Date(0).toISOString(),
              id: `${source}-${String(read)}`,
              type: `${source}.probed`,
            },
          ];
        },
      };
      await current.run({ scope: { id: `run-${source}` } } as never, () =>
        commit(write)
      );
    }

    expect(Object.fromEntries(reads)).toEqual(
      Object.fromEntries(committers.map(([source]) => [source, 1]))
    );
    expect(
      (await machine.changes(state)).map((change) => [
        change.source,
        change.id,
        change.runId,
      ])
    ).toEqual(
      committers.map(([source]) => [source, `${source}-1`, `run-${source}`])
    );
    await records.close();
    await runStore.close();
  });
});

describe("a write the recorder hands a store", () => {
  it("carries every field the store reads, own or inherited, each read once, as the store alone would read it", async () => {
    const { database } = machine.database;
    const runtime = createFakeDriver() as never;
    const SPEC = {
      image: "docker.io/oven/bun:1",
    } as const;
    const now = new Date();
    const workspaceRecord = (id: string) => ({
      createdAt: now,
      id: id as WorkspaceId,
      lastReconciledAt: now,
      name: "alpha",
      source: { kind: "host", path: `/src/${id}`, sourceId: null },
      updatedAt: now,
    });
    interface Fixture {
      readonly field: string;
      readonly name: string;
      plain(scope: string): object;
      present(store: never, id: string): Promise<boolean>;
      recorded(scope: string): Promise<object>;
      seed(store: never): Promise<string>;
      value(id: string): unknown;
    }
    const fixtures: readonly Fixture[] = [
      {
        field: "deleteTasks",
        name: "tasks",
        plain: (scope) => new SqliteTaskStore({ database, scope }),
        present: async (store: TaskStore, id) =>
          (await store.get(id as never)) !== null,
        recorded: (scope) =>
          Promise.resolve(machine.records(join(machine.root, scope)).taskStore),
        seed: async (store: TaskStore) =>
          (await new Tasks({ store }).create({ title: "t" })).id,
        value: (id) => [id],
      },
      {
        field: "deleteArtifacts",
        name: "artifacts",
        plain: (scope) => new SqliteArtifactStore({ database, scope }),
        present: async (store: ArtifactStore, id) =>
          (await store.getArtifact(id as never)) !== null,
        recorded: (scope) =>
          Promise.resolve(workspaceStores(database, scope).artifacts),
        seed: async (store: ArtifactStore) =>
          (
            await new Artifacts({ store }).create({
              entries: { "a.md": { bytes: "# A" } },
              name: "Notes",
              type: "text/markdown",
            })
          ).id,
        value: (id) => [id],
      },
      {
        field: "deleteContainers",
        name: "sandboxes",
        plain: (scope) => new SqliteContainerStore({ database, scope }),
        present: async (store: ContainerStore, id) =>
          (await store.get(id)) !== undefined,
        recorded: (scope) =>
          Promise.resolve(workspaceStores(database, scope).containers),
        seed: async (store: ContainerStore) => {
          const containers = createContainers({
            driver: runtime,
            instanceLabel: "marbles-test",
            store,
          });
          const started = await containers.start(SPEC);
          await started.close();
          await containers.shutdown();
          return started.id;
        },
        value: (id) => [id],
      },
      {
        field: "removeWorkspace",
        name: "workspaces",
        plain: (scope) => new SqliteWorkspaceStore({ database, scope }),
        present: async (store: WorkspaceStore, id) =>
          (await store.getWorkspace(id as WorkspaceId)) !== null,
        recorded: (scope) =>
          Promise.resolve(workspaceStores(database, scope).workspaces),
        seed: async (store: WorkspaceStore) => {
          const id = crypto.randomUUID();
          await new WorkspaceCatalog(store, () => undefined).create({
            entries: [],
            workspace: workspaceRecord(id),
          });
          return id;
        },
        value: (id) => id,
      },
      {
        field: "putSessions",
        name: "sessions",
        plain: (scope) => new SqliteSessionStore({ database, scope }),
        present: async (store: SessionStore, id) =>
          (await store.getSession(id)) !== null,
        recorded: (scope) =>
          Promise.resolve(new DatabaseSessionStore({ database, scope })),
        seed: () => Promise.resolve("s-variant"),
        value: (id) => [
          {
            createdAt: 1,
            id,
            parentMessageId: null,
            parentSessionId: null,
            status: "active",
            title: null,
            updatedAt: 1,
          },
        ],
      },
      {
        field: "deleteRuns",
        name: "runs",
        plain: (scope) => promised(makeSqliteQueueStore({ database, scope })),
        present: async ({ store }: ReturnType<typeof promised>, id) =>
          (await readRun(store, id)) !== null,
        recorded: async (scope) =>
          promised(
            await new DatabaseRunStore({ database, scope }).open(
              () => undefined
            )
          ),
        seed: async ({ store }: ReturnType<typeof promised>) => {
          await putRun(store, "rn-variant", undefined, { step: "s" });
          return "rn-variant";
        },
        value: (id) => [id],
      },
    ];

    for (const fixture of fixtures) {
      const outcome = async (store: object) => {
        const id = await fixture.seed(store as never);
        let reads = 0;
        const write = Object.create({
          get [fixture.field]() {
            reads += 1;
            return fixture.value(id);
          },
        }) as object;
        const refused = await (
          store as { commit(write: object): Promise<void> }
        )
          .commit(write)
          .then(
            () => null,
            (error: unknown) =>
              error instanceof Error ? error.message : String(error)
          );
        return {
          present: await fixture.present(store as never, id),
          reads,
          refused,
        };
      };
      const direct = await outcome(fixture.plain(`direct-${fixture.name}`));
      const recorded = await outcome(
        await fixture.recorded(`recorded-${fixture.name}`)
      );
      expect(recorded, fixture.name).toEqual(direct);
    }
  }, 60_000);
});

describe("a Run commit its recording refuses", () => {
  it("records no fact: the refusal rolls the facts back with the change", async () => {
    const state = machine.workspace();
    const scope = basename(state);
    const { database } = machine.database;
    const owner = new DatabaseRunStore({ database, scope });
    const other = new DatabaseRunStore({ database, scope });
    const owned = await owner.open(() => undefined);
    const run = { id: "rn-refused" } as const;
    await putRun(owned, run.id, undefined, { step: "s" });
    const before = await machine.changes(state);
    expect(before.map((change) => change.type)).toEqual(["run.queued"]);

    const elsewhere = await other.open(() => ({
      ledger: { cost: Number.NaN },
      session: { id: "run-session" },
    }));
    await expect(putRun(elsewhere, run.id, "running")).rejects.toThrow();

    expect(await machine.changes(state)).toEqual(before);
    expect((await readRun(owned, run.id))?.status).toBe("queued");
    await owner.close();
    await other.close();
  });
});

describe("a commit carrying more facts than one statement can bind", () => {
  it("records every one, each at the position the commit gave it, in the commit's own transaction", async () => {
    const state = machine.workspace();
    const scope = basename(state);
    const records = machine.records(state);
    const { artifacts } = workspaceStores(machine.database.database, scope, {
      changes: records.changes,
    });
    const manager = new Artifacts({ store: artifacts });
    const { id } = await manager.create({
      entries: { "a.md": { bytes: "# A" } },
      name: "Renamed",
      type: "text/markdown",
    });
    const before = await records.log.head();
    const renames = 5000;
    await manager.transaction(async (artifact) => {
      for (let index = 0; index < renames; index += 1) {
        await artifact.rename(id, `name ${String(index)}`);
      }
    });

    const logged = (await machine.changes(state, "artifacts")).filter(
      (change) => change.position > before
    );
    expect(logged.length).toBeGreaterThanOrEqual(renames);
    expect(logged.map((change) => change.position)).toEqual(
      logged.map((_, index) => before + index + 1)
    );
    expect(await records.log.head()).toBe(before + logged.length);
    expect((await manager.get(id))?.name).toBe(`name ${String(renames - 1)}`);
    await records.close();
  }, 60_000);
});

describe("the run a host task's fact is recorded as made by", () => {
  it("is the task's own run, though no step frame is around its body", async () => {
    const state = machine.workspace();
    const engine = testEngine({
      print: () => undefined,
      records: machine.records(state),
      state,
    });
    engine.task({
      name: "writer",
      run: () =>
        new Tasks({ store: engine.taskStore }).create({ title: "from a task" }),
    });
    await engine.start();
    const launched = await engine.launch("writer", {});
    await launched.result;
    const [fact] = await machine.changes(state, "tasks");
    expect(fact?.runId).toBe(launched.id);
    await engine.dispose();
  });
});
