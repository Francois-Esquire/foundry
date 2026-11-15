import { basename } from "node:path";
import { Sessions } from "@foundry/agents/session";
import { ArtifactManager } from "@foundry/artifacts";
import { createContainers } from "@foundry/sandbox/container/containers";
import { createFakeContainerRuntime } from "@foundry/sandbox/testing";
import { Tasks } from "@foundry/tasks";
import { ExecutionCoordinator } from "@foundry/workflows";
import type { WorkspaceId } from "@foundry/workspaces";
import { WorkspaceCatalog } from "@foundry/workspaces";
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
