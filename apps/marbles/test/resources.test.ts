import { existsSync } from "node:fs";
import { join } from "node:path";
import { Sessions } from "@foundry/agents/session";
import { SqliteSessionStore } from "@foundry/agents/store/sqlite";
import { ArtifactManager, artifactIdSchema } from "@foundry/artifacts";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import { createSqliteContainerStore } from "@foundry/sandbox/store/sqlite";
import { ExecutionCoordinator } from "@foundry/workflows";
import { SqliteWorkflowStore } from "@foundry/workflows/store/sqlite";
import { inArray } from "drizzle-orm";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { StoreDatabase } from "~/database/open";
import { initializeDatabase } from "~/database/open";
import {
  ALL_WORKSPACES,
  associationTransaction,
  ResourceView,
  readResourceView,
  resourceAssociations,
} from "~/database/resources";
import { DatabaseRunStore } from "~/database/runs";
import { DatabaseSessionStore } from "~/database/sessions";
import { workspaceStores } from "~/database/stores";
import { marblesChanges, marblesWorkflowRuns } from "~/database/tables";
import { stateDatabase } from "~/layout";
import type { ResourceRef } from "~/lib/resources";
import {
  ResourceAssociationError,
  ResourceAssociations,
} from "~/lib/resources";
import { resourceLines } from "~/resources/text";
import { seedWorkspace } from "./helpers/registry";
import { seedRuns } from "./helpers/stored-runs";
import { temporaryDirectory } from "./helpers/temporary";

const CANNOT_SHARE = /cannot be shared/;
const NO_ARTIFACT = /no artifact/;
const NO_WORKSPACE = /no workspace ws9/;
const SEEN = "2026-11-01T00:00:00.000Z";

async function machine() {
  const state = temporaryDirectory("marbles-resources-");
  for (const id of ["ws1", "ws2"]) {
    await seedWorkspace(state, {
      config: null,
      firstSeen: SEEN,
      hosted: false,
      id,
      lastSeen: SEEN,
      root: `/repo/${id}`,
    });
  }
  const opened = await initializeDatabase(stateDatabase(state));
  const { database } = opened;
  const notes = await new ArtifactManager({
    store: new SqliteArtifactStore({ database, scope: "ws1" }),
  }).create({
    entries: { "notes.md": { bytes: "# Notes\n", mime: "text/markdown" } },
    name: "notes",
    type: "text/markdown",
  });
  await new ArtifactManager({
    store: new SqliteArtifactStore({ database, scope: "ws2" }),
  }).create({
    entries: { "plan.md": { bytes: "# Plan\n", mime: "text/markdown" } },
    name: "plan",
    type: "text/markdown",
  });
  await new Sessions({
    store: new DatabaseSessionStore({ database, scope: "ws1" }),
  }).createSession({ id: "s1" });
  await createSqliteContainerStore({ database, scope: "ws1" }).commit({
    putContainers: [
      {
        createdAt: 1,
        id: "ct-1",
        nativeId: undefined,
        spec: "{}",
        status: "running",
        updatedAt: 1,
      },
    ],
  });
  opened.close();
  await seedRuns(state, "ws1", [
    { createdAt: 1, id: "rn-1", owner: null, status: "complete" },
  ]);
  const artifact: ResourceRef = {
    id: notes.id,
    kind: "artifact",
    owner: "ws1",
  };
  return { artifact, state };
}

async function withAssociations<T>(
  state: string,
  work: (associations: ReturnType<typeof resourceAssociations>) => Promise<T>
): Promise<T> {
  const opened = await initializeDatabase(stateDatabase(state));
  try {
    return await work(resourceAssociations(opened.database, state));
  } finally {
    opened.close();
  }
}

function names(state: string, workspace: string | typeof ALL_WORKSPACES) {
  return readResourceView(
    state,
    workspace === ALL_WORKSPACES ? ALL_WORKSPACES : { workspace },
    async (view) =>
      (await view.artifacts()).map((shown) => ({
        name: shown.value.name,
        workspaces: shown.workspaces,
      }))
  );
}

describe("the resource views", () => {
  it("show what a workspace owns, and everything once across every workspace", async () => {
    const { state } = await machine();
    expect(await names(state, "ws1")).toEqual([
      { name: "notes", workspaces: ["ws1"] },
    ]);
    expect(await names(state, "ws2")).toEqual([
      { name: "plan", workspaces: ["ws2"] },
    ]);
    expect(
      (await names(state, ALL_WORKSPACES))?.map((shown) => shown.name).sort()
    ).toEqual(["notes", "plan"]);
    const kinds = await readResourceView(
      state,
      { workspace: "ws1" },
      async (view) => ({
        runs: (await view.runs()).map((shown) => shown.value.record.id),
        sandboxes: (await view.sandboxes()).map((shown) => shown.ref.id),
        sessions: (await view.sessions()).map((shown) => shown.ref.id),
      })
    );
    expect(kinds).toEqual({
      runs: ["rn-1"],
      sandboxes: ["ct-1"],
      sessions: ["s1"],
    });
    expect(
      await readResourceView(state, { workspace: "ws2" }, async (view) => [
        ...(await view.runs()),
        ...(await view.sessions()),
        ...(await view.sandboxes()),
      ])
    ).toEqual([]);
  });

  it("show a shared resource in each workspace it belongs to, and stop once unshared, leaving it with its owner", async () => {
    const { artifact, state } = await machine();
    expect(
      await withAssociations(state, (associations) =>
        associations.share(artifact, "ws2")
      )
    ).toBe(true);
    expect(
      await withAssociations(state, (associations) =>
        associations.share(artifact, "ws2")
      )
    ).toBe(false);
    expect(await names(state, "ws2")).toEqual([
      { name: "plan", workspaces: ["ws2"] },
      { name: "notes", workspaces: ["ws1", "ws2"] },
    ]);
    expect(
      (await names(state, ALL_WORKSPACES))?.filter(
        (shown) => shown.name === "notes"
      )
    ).toEqual([{ name: "notes", workspaces: ["ws1", "ws2"] }]);
    expect(
      await withAssociations(state, (associations) =>
        associations.unshare(artifact, "ws2")
      )
    ).toBe(true);
    expect(await names(state, "ws2")).toEqual([
      { name: "plan", workspaces: ["ws2"] },
    ]);
    expect(await names(state, "ws1")).toEqual([
      { name: "notes", workspaces: ["ws1"] },
    ]);
  });

  it("find a shared resource by id from the workspace it is shared with", async () => {
    const { artifact, state } = await machine();
    await withAssociations(state, (associations) =>
      associations.share({ id: "s1", kind: "session", owner: "ws1" }, "ws2")
    );
    expect(
      await readResourceView(state, { workspace: "ws2" }, (view) =>
        view.find("session", "s1")
      )
    ).toEqual([{ id: "s1", kind: "session", owner: "ws1" }]);
    expect(
      await readResourceView(state, { workspace: "ws2" }, (view) =>
        view.find("artifact", artifact.id)
      )
    ).toEqual([]);
  });

  it("refuse the owner, a sandbox, and what does not exist", async () => {
    const { artifact, state } = await machine();
    const refused = (ref: ResourceRef, workspace: string) =>
      withAssociations(state, (associations) =>
        associations.share(ref, workspace)
      );
    await expect(refused(artifact, "ws1")).rejects.toThrow(
      ResourceAssociationError
    );
    await expect(
      withAssociations(state, (associations) =>
        associations.unshare(artifact, "ws1")
      )
    ).rejects.toThrow(ResourceAssociationError);
    await expect(
      refused({ id: "ct-1", kind: "sandbox", owner: "ws1" }, "ws2")
    ).rejects.toThrow(CANNOT_SHARE);
    await expect(
      refused({ ...artifact, id: "artifact#missing" }, "ws2")
    ).rejects.toThrow(NO_ARTIFACT);
    await expect(refused(artifact, "ws9")).rejects.toThrow(NO_WORKSPACE);
    expect(await names(state, "ws2")).toEqual([
      { name: "plan", workspaces: ["ws2"] },
    ]);
  });

  it("remove a resource's shares with it, so one made again with its id is not shared", async () => {
    const { artifact, state } = await machine();
    await withAssociations(state, async (associations) => {
      await associations.share(artifact, "ws2");
      await associations.share(
        { id: "rn-1", kind: "run", owner: "ws1" },
        "ws2"
      );
    });
    const opened = await initializeDatabase(stateDatabase(state));
    try {
      const { database } = opened;
      const artifacts = new ArtifactManager({
        store: workspaceStores(database, "ws1").artifacts,
      });
      await artifacts.delete(artifactIdSchema.parse(artifact.id));
      await artifacts.create({
        entries: { "notes.md": { bytes: "# Again\n", mime: "text/markdown" } },
        id: artifactIdSchema.parse(artifact.id),
        name: "notes again",
        type: "text/markdown",
      });
      const runs = await new DatabaseRunStore({ database, scope: "ws1" }).open(
        () => undefined
      );
      await runs.commit({ deleteRuns: ["rn-1"] });
    } finally {
      opened.close();
    }
    expect(await names(state, "ws2")).toEqual([
      { name: "plan", workspaces: ["ws2"] },
    ]);
    expect(await names(state, "ws1")).toEqual([
      { name: "notes again", workspaces: ["ws1"] },
    ]);
    expect(
      await withAssociations(state, (associations) =>
        associations.sharedWith({ id: "rn-1", kind: "run", owner: "ws1" })
      )
    ).toEqual([]);
  });

  it("share a resource deleted during the share either not at all or with the delete taking the share, never leaving it for a new one of the same id", async () => {
    const { artifact, state } = await machine();
    const opened = await initializeDatabase(stateDatabase(state));
    try {
      const { database } = opened;
      const real = associationTransaction(database, state);
      let checked: () => void = () => undefined;
      let resume: () => void = () => undefined;
      const wasChecked = new Promise<void>((settle) => {
        checked = settle;
      });
      const resumed = new Promise<void>((settle) => {
        resume = settle;
      });
      const paused = new ResourceAssociations({
        transact: (work) =>
          real((unit) =>
            work({
              ...unit,
              directory: {
                ...unit.directory,
                has: async (ref) => {
                  const found = await unit.directory.has(ref);
                  checked();
                  await resumed;
                  return found;
                },
              },
            })
          ),
      });
      const artifacts = new ArtifactManager({
        store: workspaceStores(database, "ws1").artifacts,
      });
      const sharing = paused.share(artifact, "ws2");
      await wasChecked;
      let deleted = false;
      const deleting = artifacts
        .delete(artifactIdSchema.parse(artifact.id))
        .then(() => {
          deleted = true;
        });
      await new Promise((settle) => setTimeout(settle, 50));
      expect(deleted).toBe(false);
      resume();
      expect(await sharing).toBe(true);
      await deleting;
      const associations = resourceAssociations(database, state);
      expect(await associations.sharedWith(artifact)).toEqual([]);
      await artifacts.create({
        entries: { "notes.md": { bytes: "# New\n", mime: "text/markdown" } },
        id: artifactIdSchema.parse(artifact.id),
        name: "new notes",
        type: "text/markdown",
      });
      expect(await associations.sharedWith(artifact)).toEqual([]);
    } finally {
      opened.close();
    }
  });

  it("read sessions and their tallies in a batch per owner, and the owners of shared runs once per owner", async () => {
    const { state } = await machine();
    const opened = await initializeDatabase(stateDatabase(state));
    try {
      const { database } = opened;
      const sessions = new Sessions({
        store: new DatabaseSessionStore({ database, scope: "ws1" }),
      });
      for (let index = 0; index < 30; index += 1) {
        await sessions.createSession({ id: `many-${String(index)}` });
      }
      await seedRunsOn(database, "ws2", 20);
      const associations = resourceAssociations(database, state);
      for (let index = 0; index < 20; index += 1) {
        await associations.share(
          { id: `shared-${String(index)}`, kind: "run", owner: "ws2" },
          "ws1"
        );
      }
      const getSession = vi.spyOn(SqliteSessionStore.prototype, "getSession");
      const getSessions = vi.spyOn(SqliteSessionStore.prototype, "getSessions");
      const listMessages = vi.spyOn(
        SqliteSessionStore.prototype,
        "listMessages"
      );
      const tallies = vi.spyOn(SqliteSessionStore.prototype, "messageTallies");
      onTestFinished(() => {
        vi.restoreAllMocks();
      });
      let pidReads = 0;
      const counted = new Proxy(database, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target);
          if (property !== "select" || typeof value !== "function") {
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (...args: unknown[]) => {
            const query = Reflect.apply(value, target, args) as {
              from(table: unknown): unknown;
            };
            const from = query.from.bind(query);
            query.from = (table: unknown) => {
              if (table === marblesWorkflowRuns) {
                pidReads += 1;
              }
              return from(table);
            };
            return query;
          };
        },
      });
      const view = new ResourceView({
        database: counted,
        scope: { workspace: "ws1" },
        state,
      });
      const lines = await resourceLines("session", view, "ws1");
      expect(lines).toHaveLength(31);
      expect(getSession).not.toHaveBeenCalled();
      expect(listMessages).not.toHaveBeenCalled();
      expect(getSessions).toHaveBeenCalledTimes(1);
      expect(tallies).toHaveBeenCalledTimes(1);
      expect(await view.sharedRuns()).toHaveLength(20);
      expect(pidReads).toBe(1);
    } finally {
      opened.close();
    }
  });

  it("read a resource's shares without a write transaction, and check and write a share in one", async () => {
    const { artifact, state } = await machine();
    const opened = await initializeDatabase(stateDatabase(state));
    try {
      let transactions = 0;
      const counted = new Proxy(opened.database, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target);
          if (property === "transaction" && typeof value === "function") {
            return (...args: unknown[]) => {
              transactions += 1;
              return Reflect.apply(value, target, args);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const associations = resourceAssociations(counted, state);
      expect(await associations.sharedWith(artifact)).toEqual([]);
      expect(transactions).toBe(0);
      await associations.share(artifact, "ws2");
      expect(transactions).toBe(1);
    } finally {
      opened.close();
    }
  });

  it("record an artifact's share and unshare in its owner's change log alone, naming the other workspace", async () => {
    const { artifact, state } = await machine();
    const opened = await initializeDatabase(stateDatabase(state));
    try {
      const { database } = opened;
      const associations = resourceAssociations(database, state);
      await associations.share(artifact, "ws2");
      await associations.unshare(artifact, "ws2");
      await associations.share(
        { id: "rn-1", kind: "run", owner: "ws1" },
        "ws2"
      );
      const facts = await database
        .select({
          payload: marblesChanges.payload,
          scope: marblesChanges.scope,
          source: marblesChanges.source,
          type: marblesChanges.type,
        })
        .from(marblesChanges)
        .where(
          inArray(marblesChanges.type, ["artifact.shared", "artifact.unshared"])
        )
        .orderBy(marblesChanges.position);
      expect(facts).toEqual([
        {
          payload: expect.objectContaining({
            artifactId: artifact.id,
            type: "artifact.shared",
            workspace: "ws2",
          }),
          scope: "ws1",
          source: "artifacts",
          type: "artifact.shared",
        },
        {
          payload: expect.objectContaining({
            artifactId: artifact.id,
            type: "artifact.unshared",
            workspace: "ws2",
          }),
          scope: "ws1",
          source: "artifacts",
          type: "artifact.unshared",
        },
      ]);
    } finally {
      opened.close();
    }
  });

  it("read nothing, and make no database, under an empty state root", async () => {
    const state = temporaryDirectory("marbles-resources-");
    expect(
      await readResourceView(state, ALL_WORKSPACES, (view) => view.runs())
    ).toBeUndefined();
    expect(existsSync(join(state, "marbles.db"))).toBe(false);
  });
});

async function seedRunsOn(
  database: StoreDatabase,
  scope: string,
  count: number
): Promise<void> {
  const coordinator = new ExecutionCoordinator({
    store: new SqliteWorkflowStore({ database, scope }),
  });
  const queue = await coordinator.ensureQueue({ id: "qu-many", name: "many" });
  for (let index = 0; index < count; index += 1) {
    const id = `shared-${String(index)}`;
    await coordinator.createRun({
      id,
      input: null,
      queueId: queue.id,
      step: "s",
    });
    await database.insert(marblesWorkflowRuns).values({
      ledger: {},
      literals: {},
      ownerId: null,
      ownerPid: null,
      runId: id,
      scope,
    });
  }
}
