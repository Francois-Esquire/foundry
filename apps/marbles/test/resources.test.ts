import { existsSync } from "node:fs";
import { join } from "node:path";
import { Sessions } from "@foundry/agents/session";
import { ArtifactManager } from "@foundry/artifacts";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import { createSqliteContainerStore } from "@foundry/sandbox/store/sqlite";
import { describe, expect, it } from "vitest";
import { initializeDatabase } from "~/database/open";
import {
  ALL_WORKSPACES,
  readResourceView,
  resourceAssociations,
} from "~/database/resources";
import { DatabaseSessionStore } from "~/database/sessions";
import { stateDatabase } from "~/layout";
import type { ResourceRef } from "~/lib/resources";
import { ResourceAssociationError } from "~/lib/resources";
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

  it("read nothing, and make no database, under an empty state root", async () => {
    const state = temporaryDirectory("marbles-resources-");
    expect(
      await readResourceView(state, ALL_WORKSPACES, (view) => view.runs())
    ).toBeUndefined();
    expect(existsSync(join(state, "marbles.db"))).toBe(false);
  });
});
