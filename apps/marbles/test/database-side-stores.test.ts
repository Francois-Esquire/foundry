import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withWorkspaceDatabase } from "~/database/managed";
import { initializeDatabase } from "~/database/open";
import { DatabaseWorkspaceRecords } from "~/database/tasks";
import type { EngineOptions } from "~/lib/engine";
import type { ActivityRecord } from "~/lib/sandbox/activities";
import { testInstances } from "./helpers/engine";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "marbles-side-"));
  roots.push(root);
  return root;
}

const source = { definition: "review", path: ["review"], runId: "run-1" };
const session = { agentId: "coder", sessionId: "session-1", source };
const activity: ActivityRecord = {
  event: {
    agentId: "coder",
    harness: "codex",
    id: "child-1",
    kind: "subagent",
    lifetime: "session",
    revision: 1,
    sessionId: "session-1",
    status: "running",
    title: "Review files",
  },
  source,
};

/** Close what an engine closes on dispose: every store `withWorkspaceDatabase` counted. */
async function dispose(options: EngineOptions): Promise<void> {
  await options.records?.close();
  await options.runs?.close();
  await options.triggers?.close();
  await options.usageStore?.close();
  await options.automationStore?.close();
  await options.executionStore?.close();
}

describe("the stores an engine keeps beside its records", () => {
  it("are kept in the engine's own database for the next engine, and refused once its handle is given up", async () => {
    const state = join(scratch(), "app-state");
    const options = () => {
      const root = scratch();
      return withWorkspaceDatabase({
        ...testInstances({ root }),
        root,
        state,
        workspaceId: "side",
      });
    };
    const first = options();
    await first.grants?.transact(() => ({ next: "{}", result: undefined }));
    await first.approvals?.change((saved) => ({
      ...saved,
      sessions: [session],
    }));
    await first.activityStore?.put("child-1", activity);
    await dispose(first);
    await expect(first.approvals?.load()).rejects.toThrow("closed");

    const second = options();
    try {
      expect(await second.approvals?.load()).toEqual({
        requests: [],
        sessions: [session],
      });
      expect(await second.activityStore?.load()).toEqual([activity]);
      expect(
        await second.grants?.transact((stored) => ({ result: stored }))
      ).toBe("{}");
    } finally {
      await dispose(second);
    }
  });

  it("keep an activity's highest revision", async () => {
    const options = withWorkspaceDatabase({
      ...testInstances({ root: scratch() }),
      root: scratch(),
      state: join(scratch(), "revisions"),
      workspaceId: "revisions",
    });
    try {
      const at = (revision: number, title: string): ActivityRecord => ({
        ...activity,
        event: { ...activity.event, revision, title },
      });
      await options.activityStore?.put("child-1", at(2, "second"));
      await options.activityStore?.put("child-1", at(1, "first"));
      expect(await options.activityStore?.load()).toEqual([at(2, "second")]);
      await options.activityStore?.put("child-1", at(3, "third"));
      expect(await options.activityStore?.load()).toEqual([at(3, "third")]);
    } finally {
      await dispose(options);
    }
  });
});

describe("who delivers a workspace's task changes", () => {
  it("stays held when its release fails, so a retry gives it up", async () => {
    const opened = await initializeDatabase(join(scratch(), "marbles.db"));
    try {
      let failing = false;
      // The database, refusing the next update as a held write lock would.
      const database = new Proxy(opened.database, {
        get(target, property) {
          if (property === "update" && failing) {
            failing = false;
            return () => {
              throw new Error("SQLITE_BUSY: database is locked");
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const first = new DatabaseWorkspaceRecords({ database, scope: "ws" });
      const second = new DatabaseWorkspaceRecords({
        database: opened.database,
        scope: "ws",
      });
      expect(await first.claimDelivery()).toBeUndefined();
      failing = true;
      await expect(first.releaseDelivery()).rejects.toThrow("SQLITE_BUSY");
      expect(await second.claimDelivery()).toBe(
        "another engine in this process"
      );
      await first.releaseDelivery();
      expect(await second.claimDelivery()).toBeUndefined();
    } finally {
      opened.close();
    }
  });

  it("is given up by records closed while their claim was under way", async () => {
    const opened = await initializeDatabase(join(scratch(), "marbles.db"));
    try {
      const records = () =>
        new DatabaseWorkspaceRecords({
          database: opened.database,
          scope: "ws",
        });
      const first = records();
      const claiming = first.claimDelivery();
      await first.close();
      expect(await claiming).toBeUndefined();
      expect(await records().claimDelivery()).toBeUndefined();
    } finally {
      opened.close();
    }
  });

  it("is one engine's records at a time, until they let go or close", async () => {
    const opened = await initializeDatabase(join(scratch(), "marbles.db"));
    try {
      const records = () =>
        new DatabaseWorkspaceRecords({
          database: opened.database,
          scope: "ws",
        });
      const [first, second] = [records(), records()];
      expect(await first.claimDelivery()).toBeUndefined();
      expect(await first.claimDelivery()).toBeUndefined();
      expect(await second.claimDelivery()).toBe(
        "another engine in this process"
      );
      // Another workspace's delivery is its own.
      expect(
        await new DatabaseWorkspaceRecords({
          database: opened.database,
          scope: "other",
        }).claimDelivery()
      ).toBeUndefined();
      await first.releaseDelivery();
      expect(await second.claimDelivery()).toBeUndefined();
      expect(await first.claimDelivery()).toBe(
        "another engine in this process"
      );
      await second.close();
      expect(await first.claimDelivery()).toBeUndefined();
    } finally {
      opened.close();
    }
  });
});
