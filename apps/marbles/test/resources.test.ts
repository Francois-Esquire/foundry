import { existsSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { Sessions } from "@foundry/agents/session";
import { SqliteSessionStore } from "@foundry/agents/store/sqlite";
import { Artifacts } from "@foundry/artifacts";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import { SqliteContainerStore } from "@foundry/sandbox/store/sqlite";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { resourceLines } from "~/cli/format/resources";
import { initializeDatabase, readResourceView } from "~/database/open";
import { ALL_WORKSPACES, ResourceView } from "~/database/resources";
import { DatabaseSessionStore } from "~/database/sessions";
import { stateDatabase } from "~/layout";
import { insideState } from "~/state/workspace";
import { seedWorkspace } from "./helpers/registry";
import { seedRuns } from "./helpers/stored-runs";
import { temporaryDirectory } from "./helpers/temporary";

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
  await new Artifacts({
    store: new SqliteArtifactStore({ database, scope: "ws1" }),
  }).create({
    entries: { "notes.md": { bytes: "# Notes\n", mime: "text/markdown" } },
    name: "notes",
    type: "text/markdown",
  });
  await new Artifacts({
    store: new SqliteArtifactStore({ database, scope: "ws2" }),
  }).create({
    entries: { "plan.md": { bytes: "# Plan\n", mime: "text/markdown" } },
    name: "plan",
    type: "text/markdown",
  });
  await new Sessions({
    store: new DatabaseSessionStore({ database, scope: "ws1" }),
  }).createSession({ id: "s1" });
  await new SqliteContainerStore({ database, scope: "ws1" }).commit({
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
  return { state };
}

function names(state: string, workspace: string | typeof ALL_WORKSPACES) {
  return readResourceView(
    state,
    workspace === ALL_WORKSPACES ? ALL_WORKSPACES : { workspace },
    async (view) =>
      (await view.artifacts()).map((shown) => ({
        name: shown.value.name,
        owner: shown.ref.owner,
      }))
  );
}

describe("the resource views", () => {
  it("show what a workspace owns, and everything once across every workspace", async () => {
    const { state } = await machine();
    expect(await names(state, "ws1")).toEqual([
      { name: "notes", owner: "ws1" },
    ]);
    expect(await names(state, "ws2")).toEqual([{ name: "plan", owner: "ws2" }]);
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

  it("show nothing a workspace whose state directory is a link owns, across every workspace", async () => {
    const { state } = await machine();
    const elsewhere = temporaryDirectory("marbles-resources-elsewhere-");
    rmSync(join(state, "ws1"), { force: true, recursive: true });
    symlinkSync(elsewhere, join(state, "ws1"));
    expect(
      (await names(state, ALL_WORKSPACES))?.map((shown) => shown.name)
    ).toEqual(["plan"]);
  });

  it("read sessions and their tallies in a batch per owner", async () => {
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
      const view = new ResourceView({
        acceptWorkspace: (workspaceId) => insideState(state, workspaceId),
        database,
        scope: { workspace: "ws1" },
      });
      const lines = await resourceLines("session", view, "ws1");
      expect(lines).toHaveLength(31);
      expect(getSession).not.toHaveBeenCalled();
      expect(listMessages).not.toHaveBeenCalled();
      expect(getSessions).toHaveBeenCalledTimes(1);
      expect(tallies).toHaveBeenCalledTimes(1);
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
