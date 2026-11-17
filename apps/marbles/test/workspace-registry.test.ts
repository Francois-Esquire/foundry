import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarblesDatabase } from "~/database/open";
import { initializeDatabase } from "~/database/open";
import { transaction } from "~/database/transaction";
import { recordedWorkspaces, WorkspaceRegistry } from "~/database/workspaces";
import { stateDatabase } from "~/layout";
import { workspaceState } from "~/lib/state/workspace";
import { recordedWorkspace } from "~/workspace/open";

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("WorkspaceRegistry", () => {
  let state: string;
  let opened: MarblesDatabase;
  let registry: WorkspaceRegistry;

  beforeEach(async () => {
    state = scratch("marbles-state-");
    opened = await initializeDatabase(stateDatabase(state));
    registry = new WorkspaceRegistry({ database: opened.database, state });
  });

  afterEach(() => {
    vi.useRealTimers();
    opened.close();
  });

  it("records the first sight once and every sight after", async () => {
    const root = scratch("marbles-ws-");
    const workspace = workspaceState(state, root);
    vi.useFakeTimers({ now: Date.parse("2026-11-01T00:00:00.000Z") });
    await registry.touch(workspace, join(root, "marbles.config.ts"));
    expect(await registry.read(workspace.id)).toEqual({
      config: join(root, "marbles.config.ts"),
      cwd: workspace.root,
      firstSeen: "2026-11-01T00:00:00.000Z",
      hosted: false,
      id: workspace.id,
      lastSeen: "2026-11-01T00:00:00.000Z",
      root: workspace.root,
    });

    vi.setSystemTime(Date.parse("2026-11-02T00:00:00.000Z"));
    await registry.touch(workspace, null);
    expect(await registry.read(workspace.id)).toMatchObject({
      config: null,
      firstSeen: "2026-11-01T00:00:00.000Z",
      lastSeen: "2026-11-02T00:00:00.000Z",
    });
  });

  it("registers where a workspace's work starts, its root unless given", async () => {
    const root = scratch("marbles-ws-");
    const workspace = workspaceState(state, root);
    const elsewhere = scratch("marbles-cwd-");
    await registry.touch(workspace, null, { cwd: elsewhere });
    expect((await registry.read(workspace.id))?.cwd).toBe(elsewhere);
    await registry.touch(workspace, null, { cwd: workspace.root });
    expect((await registry.read(workspace.id))?.cwd).toBe(workspace.root);
    expect((await registry.list()).map((record) => record.cwd)).toEqual([
      workspace.root,
    ]);
  });

  it("keeps whether the process hosts a workspace unless told", async () => {
    const workspace = workspaceState(state, scratch("marbles-ws-"));
    await registry.touch(workspace, null, { hosted: true });
    await registry.touch(workspace, null);
    expect((await registry.read(workspace.id))?.hosted).toBe(true);
    await registry.touch(workspace, null, { hosted: false });
    expect((await registry.read(workspace.id))?.hosted).toBe(false);
  });

  it("lists every record by id, and reads nothing for an unknown one", async () => {
    const a = workspaceState(state, scratch("marbles-ws-"));
    const b = workspaceState(state, scratch("marbles-ws-"));
    await registry.touch(a, null);
    await registry.touch(b, null);
    expect((await registry.list()).map((record) => record.id)).toEqual(
      [a.id, b.id].sort()
    );
    expect(await registry.read("missing")).toBeUndefined();
  });

  it("hands out records a caller can change without changing the store", async () => {
    const workspace = workspaceState(state, scratch("marbles-ws-"));
    await registry.touch(workspace, null);
    const [listed] = await registry.list();
    if (listed === undefined) {
      throw new Error("the record is missing");
    }
    Object.assign(listed, { root: "/elsewhere" });
    expect((await registry.read(workspace.id))?.root).toBe(workspace.root);
  });

  it("keeps its records across closing and reopening the database", async () => {
    const workspace = workspaceState(state, scratch("marbles-ws-"));
    await registry.touch(workspace, null);
    opened.close();
    opened = await initializeDatabase(stateDatabase(state));
    const reopened = new WorkspaceRegistry({
      database: opened.database,
      state,
    });
    expect((await reopened.read(workspace.id))?.root).toBe(workspace.root);
  });

  it("writes inside a transaction it is handed, and rolls back with it", async () => {
    const kept = workspaceState(state, scratch("marbles-ws-"));
    const dropped = workspaceState(state, scratch("marbles-ws-"));
    await transaction(opened.database, (tx) =>
      new WorkspaceRegistry({ database: tx, state }).touch(kept, null)
    );
    await expect(
      transaction(opened.database, async (tx) => {
        await new WorkspaceRegistry({ database: tx, state }).touch(
          dropped,
          null
        );
        throw new Error("the change failed");
      })
    ).rejects.toThrow("the change failed");
    expect((await registry.list()).map((record) => record.id)).toEqual([
      kept.id,
    ]);
  });

  it("leaves out a workspace whose directory links out of the state root", async () => {
    const kept = workspaceState(state, scratch("marbles-ws-"));
    const linked = workspaceState(state, scratch("marbles-ws-"));
    await registry.touch(kept, null);
    await registry.touch(linked, null);
    const outside = scratch("marbles-outside-");
    symlinkSync(outside, linked.dir);
    mkdirSync(kept.dir);
    expect(
      (await recordedWorkspaces(state)).map((record) => record.id)
    ).toEqual([kept.id]);
    const args = { artifacts: "", config: "", dry: false, state };
    expect((await recordedWorkspace(args, kept.id))?.workspace).toEqual(kept);
    expect(await recordedWorkspace(args, linked.id)).toBeUndefined();
    expect(await recordedWorkspace(args, "missing")).toBeUndefined();
  });
});

describe("a state root without a database", () => {
  it("records nothing, and is left without one", async () => {
    const state = scratch("marbles-state-");
    const args = { artifacts: "", config: "", dry: false, state };
    expect(await recordedWorkspaces(state)).toEqual([]);
    expect(await recordedWorkspace(args, "any")).toBeUndefined();
    expect(existsSync(stateDatabase(state))).toBe(false);
  });
});
