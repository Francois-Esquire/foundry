import { basename, join } from "node:path";
import { Sessions } from "@foundry/agents/session";
import type { SessionStore } from "@foundry/agents/store";
import { SqliteSessionStore } from "@foundry/agents/store/sqlite";
import { ArtifactManager } from "@foundry/artifacts";
import type { ArtifactStore } from "@foundry/artifacts/store";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import { createContainers } from "@foundry/sandbox/container/containers";
import type { ContainerStore } from "@foundry/sandbox/store";
import { createSqliteContainerStore } from "@foundry/sandbox/store/sqlite";
import { createFakeContainerRuntime } from "@foundry/sandbox/testing";
import type { TaskStore } from "@foundry/tasks";
import { Tasks } from "@foundry/tasks";
import { SqliteTaskStore } from "@foundry/tasks/store/sqlite";
import { ExecutionCoordinator } from "@foundry/workflows";
import type { WorkflowStore } from "@foundry/workflows/store";
import { SqliteWorkflowStore } from "@foundry/workflows/store/sqlite";
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
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";

/**
 * Each source end to end: the package's own domain class changes its
 * objects through the store Marbles builds over the Marbles database, the
 * store's hook records the facts in the workspace's change log in the
 * commit, and delivery hands them to the observers of that source alone.
 */

let machine: TestMachine;

beforeAll(async () => {
  machine = await testMachine();
});

afterAll(() => {
  machine.close();
});

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
    const stores = workspaceStores(database, scope, changes);
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

    // Each package's domain class, over the store Marbles hands it.
    await new Tasks({ store: records.taskStore }).create({ title: "Task" });
    const artifacts = new ArtifactManager({ store: stores.artifacts });
    await artifacts.create({
      entries: { "a.md": { bytes: "# A" } },
      name: "Notes",
      type: "text/markdown",
    });
    const containers = createContainers({
      instanceLabel: "marbles-test",
      runtime: createFakeContainerRuntime() as never,
      store: stores.containers,
    });
    const sandbox = await containers.start({
      format: "foundry.sandbox.container/1",
      image: "docker.io/oven/bun:1",
    });
    await sandbox.close();
    await containers.shutdown();
    await new Sessions({ store: sessionStore }).createSession({ id: "s1" });
    const coordinator = new ExecutionCoordinator({
      store: await runStore.open(() => undefined),
    });
    const run = await coordinator.createRun({
      input: null,
      queueId: "q",
      step: "s",
    });
    await coordinator.updateRun(run.id, { status: "running" });
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

    // One log, one counter: the positions follow the commits, each once.
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
      // Nothing here ran inside a run.
      expect(change.runId).toBeNull();
    }
    // Every observer ended where the log does.
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
    const stores = workspaceStores(database, scope, changes);
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
        // A catalogue write names a Workspace: one that is not filed here.
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
          (await runStore.open(() => undefined)).commit(write as never),
      ],
    ];
    const reads = new Map<string, number>();
    for (const [source, commit] of committers) {
      reads.set(source, 0);
      // A write whose events read differently each time they are read.
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
    const runtime = createFakeContainerRuntime() as never;
    const SPEC = {
      format: "foundry.sandbox.container/1",
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
      /** The store of `scope`, as the package makes it, with no recorder. */
      plain(scope: string): object;
      present(store: never, id: string): Promise<boolean>;
      /** The store of `scope` as Marbles hands it over, through the recorder. */
      recorded(scope: string): Promise<object>;
      /** The id to name in the write, after filing what it names. */
      seed(store: never): Promise<string>;
      /** The field's value for `id`. */
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
            await new ArtifactManager({ store }).create({
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
        plain: (scope) => createSqliteContainerStore({ database, scope }),
        present: async (store: ContainerStore, id) =>
          (await store.get(id)) !== undefined,
        recorded: (scope) =>
          Promise.resolve(workspaceStores(database, scope).containers),
        seed: async (store: ContainerStore) => {
          const containers = createContainers({
            instanceLabel: "marbles-test",
            runtime,
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
        plain: (scope) => new SqliteWorkflowStore({ database, scope }),
        present: async (store: WorkflowStore, id) =>
          (await store.getRun(id)) !== null,
        recorded: (scope) =>
          new DatabaseRunStore({ database, scope }).open(() => undefined),
        seed: async (store: WorkflowStore) =>
          (
            await new ExecutionCoordinator({ store }).createRun({
              input: null,
              queueId: "q",
              step: "s",
            })
          ).id,
        value: (id) => [id],
      },
    ];

    for (const fixture of fixtures) {
      const outcome = async (store: object) => {
        const id = await fixture.seed(store as never);
        let reads = 0;
        // Every field of the write is a getter on its prototype.
        const write = Object.create({
          get [fixture.field]() {
            reads += 1;
            return fixture.value(id);
          },
        }) as object;
        // As the store takes it: what it keeps, or how it refuses.
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

describe("a Run commit the owner check refuses", () => {
  it("records no fact: a RunMovedError rolls the facts back with the change", async () => {
    const state = machine.workspace();
    const scope = basename(state);
    const { database } = machine.database;
    const owner = new DatabaseRunStore({ database, scope });
    const other = new DatabaseRunStore({ database, scope });
    const owned = new ExecutionCoordinator({
      store: await owner.open(() => undefined),
    });
    // Filed, unsettled, by the owner: its Run is the owner's to change.
    const run = await owned.createRun({ input: null, queueId: "q", step: "s" });
    const before = await machine.changes(state);
    expect(before.map((change) => change.type)).toEqual(["run.queued"]);

    const elsewhere = new ExecutionCoordinator({
      store: await other.open(() => undefined),
    });
    await expect(
      elsewhere.updateRun(run.id, { status: "running" })
    ).rejects.toThrow("is not held by this engine any more");

    expect(await machine.changes(state)).toEqual(before);
    expect((await owned.getRun(run.id))?.status).toBe("queued");
    await owner.close();
    await other.close();
  });
});
