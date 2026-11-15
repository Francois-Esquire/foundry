import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceDatabaseOptions } from "~/database/managed";
import {
  defaultWorkspaceTriggers,
  openWorkspaceDatabase,
  withWorkspaceDatabase,
} from "~/database/managed";
import { initializeDatabase } from "~/database/open";
import { DatabaseWorkspaceRecords } from "~/database/tasks";
import { MemoryAutomationStore } from "~/lib/automation/store";
import { MemoryWorkspaceRecords } from "~/lib/events/records";
import { MemoryExecutionStore } from "~/lib/execution-store";
import { MemoryRunStore } from "~/lib/run-store";
import type { ActivityRecord } from "~/lib/sandbox/activities";
import { MemoryTriggerStore } from "~/lib/trigger-store";
import { MemoryUsageStore } from "~/lib/usage-store";
import { testEngine, testInstances } from "./helpers/engine";

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

/**
 * Close what an engine closes on dispose, every store `withWorkspaceDatabase`
 * counted, then give up the hold the engine keeps.
 */
async function dispose({
  options,
  release,
}: WorkspaceDatabaseOptions): Promise<void> {
  await options.records?.close();
  await options.runs?.close();
  await options.triggers?.close();
  await options.usageStore?.close();
  await options.automationStore?.close();
  await options.executionStore?.close();
  await release();
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
    await first.options.grants?.transact(() => ({
      next: "{}",
      result: undefined,
    }));
    await first.options.approvals?.change((saved) => ({
      ...saved,
      sessions: [session],
    }));
    await first.options.activityStore?.put("child-1", activity);
    await dispose(first);
    await expect(first.options.approvals?.load()).rejects.toThrow("closed");

    const second = options();
    try {
      expect(await second.options.approvals?.load()).toEqual({
        requests: [],
        sessions: [session],
      });
      expect(await second.options.activityStore?.load()).toEqual([activity]);
      expect(
        await second.options.grants?.transact((stored) => ({ result: stored }))
      ).toBe("{}");
    } finally {
      await dispose(second);
    }
  });

  it("are kept, and their handle closed on dispose, when the engine is handed every other store", async () => {
    const state = join(scratch(), "handed");
    const root = scratch();
    const engine = () =>
      testEngine({
        automationStore: new MemoryAutomationStore(),
        executionStore: new MemoryExecutionStore(),
        records: new MemoryWorkspaceRecords(),
        root,
        runs: new MemoryRunStore(),
        state,
        triggers: new MemoryTriggerStore(),
        usageStore: new MemoryUsageStore(),
        workspaceId: "handed",
      }).start();
    const first = await engine();
    await first.activities.record(activity.event, activity.source);
    await first.dispose();
    const late = { ...activity.event, revision: 2 };
    await expect(first.activities.record(late, source)).rejects.toThrow(
      "closed"
    );

    const second = await engine();
    try {
      // Listed as no longer live, since no session of this engine runs it.
      expect(second.activities.list()).toEqual([
        {
          event: { ...activity.event, actions: [], status: "unknown" },
          source,
        },
      ]);
    } finally {
      await second.dispose();
    }
  });

  it("stay open until the engine lets go, after the stores made beside them close", async () => {
    const kept = withWorkspaceDatabase({
      ...testInstances({ root: scratch() }),
      root: scratch(),
      state: join(scratch(), "held"),
      usageStore: new MemoryUsageStore(),
      workspaceId: "held",
    });
    const { options } = kept;
    await options.records?.close();
    await options.runs?.close();
    await options.triggers?.close();
    await options.automationStore?.close();
    await options.executionStore?.close();
    // An agent still closing writes its activity after the engine's stores closed.
    await options.activityStore?.put("child-1", activity);
    await kept.release();
    await kept.release();
    await expect(options.activityStore?.load()).rejects.toThrow("closed");
  });

  it("stay open when a store made beside them is closed more than once", async () => {
    const kept = withWorkspaceDatabase({
      ...testInstances({ root: scratch() }),
      root: scratch(),
      state: join(scratch(), "twice"),
      workspaceId: "twice",
    });
    const { options } = kept;
    await options.activityStore?.load();
    // Each close of the same store gives up that store's claim once.
    await options.records?.close();
    await options.records?.close();
    await options.runs?.close();
    await options.triggers?.close();
    await options.usageStore?.close();
    await options.automationStore?.close();
    await options.executionStore?.close();
    await options.executionStore?.close();
    expect(await options.activityStore?.load()).toEqual([]);
    await kept.release();
    await expect(options.activityStore?.load()).rejects.toThrow("closed");
  });

  it("finish one close of a store, cleanup first, whoever else closes it meanwhile", async () => {
    const stores = [
      "records",
      "runs",
      "triggers",
      "usageStore",
      "automationStore",
      "executionStore",
    ] as const;
    for (const overlapping of stores) {
      const kept = withWorkspaceDatabase({
        ...testInstances({ root: scratch() }),
        root: scratch(),
        state: join(scratch(), `overlap-${overlapping}`),
        workspaceId: "overlap",
      });
      const { options } = kept;
      // Opened, with something each store gives up as it closes.
      await options.triggers?.lastTick("tick");
      await options.records?.claimDelivery();
      for (const other of stores.filter((each) => each !== overlapping)) {
        await options[other]?.close();
      }
      const first = options[overlapping]?.close();
      const second = options[overlapping]?.close();
      expect(second, overlapping).toBe(first);
      await second;
      await kept.release();
      expect(
        (await Promise.allSettled([first, second])).map((each) => each.status),
        overlapping
      ).toEqual(["fulfilled", "fulfilled"]);
    }
  });

  it("close the handle a workspace's own database opened once, for every overlapping close", async () => {
    const database = openWorkspaceDatabase({
      state: join(scratch(), "own"),
      workspaceId: "own",
    });
    await database.triggers.lastTick("tick");
    let firstDone = false;
    const first = database.close().then(() => {
      firstDone = true;
    });
    await database.close();
    expect(firstDone).toBe(true);
    await first;
  });

  it("finish an overlapping close of a store that owns its handle before either resolves", async () => {
    const root = scratch();
    const triggers = defaultWorkspaceTriggers(
      join(scratch(), "triggers"),
      root,
      "triggers"
    );
    await triggers.lastTick("tick");
    const first = triggers.close();
    const second = triggers.close();
    expect(second).toBe(first);
    expect(
      (await Promise.allSettled([first, second])).map((each) => each.status)
    ).toEqual(["fulfilled", "fulfilled"]);
  });

  it("keep an activity's highest revision", async () => {
    const { options, release } = withWorkspaceDatabase({
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
      await dispose({ options, release });
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
