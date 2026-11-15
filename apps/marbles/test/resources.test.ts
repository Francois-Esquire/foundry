import { existsSync } from "node:fs";
import { join } from "node:path";
import { Sessions } from "@foundry/agents/session";
import { ArtifactManager, artifactIdSchema } from "@foundry/artifacts";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import { createSqliteContainerStore } from "@foundry/sandbox/store/sqlite";
import { describe, expect, it } from "vitest";
import { initializeDatabase } from "~/database/open";
import {
  ALL_WORKSPACES,
  associationTransaction,
  readResourceView,
  resourceAssociations,
} from "~/database/resources";
import { DatabaseRunStore } from "~/database/runs";
import { DatabaseSessionStore } from "~/database/sessions";
import { workspaceStores } from "~/database/stores";
import { stateDatabase } from "~/layout";
import type { ResourceRef } from "~/lib/resources";
import {
  ResourceAssociationError,
  ResourceAssociations,
} from "~/lib/resources";
import { seedWorkspace } from "./helpers/registry";
import { seedRuns } from "./helpers/stored-runs";
import { temporaryDirectory } from "./helpers/temporary";

/**
 * Resources are kept centrally, each by its owner's store; a workspace
 * shows what it owns and what is shared with it, and the all-workspaces
 * view shows everything once.
 */

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
    // Across every workspace a shared resource is still one resource.
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
      // The share pauses inside its transaction, right after its check.
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

  it("read nothing, and make no database, under an empty state root", async () => {
    const state = temporaryDirectory("marbles-resources-");
    expect(
      await readResourceView(state, ALL_WORKSPACES, (view) => view.runs())
    ).toBeUndefined();
    expect(existsSync(join(state, "marbles.db"))).toBe(false);
  });
});
