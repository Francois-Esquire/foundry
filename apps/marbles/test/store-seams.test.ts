import { MemorySessionStore } from "@foundry/agents/store/memory";
import { MemoryArtifactStore } from "@foundry/artifacts/store/memory";
import type { GrantDocumentStorage } from "@foundry/lib/authorization/document";
import { DEFAULT_POOL, type JobId, type RunId } from "@foundry/queue";
import { MemoryContainerStore } from "@foundry/sandbox/store/memory";
import { taskId } from "@foundry/tasks";
import { MemoryWorkspaceStore } from "@foundry/workspaces/store/memory";
import { describe, expect, test } from "vitest";
import { Catalog } from "~/authoring/catalog";
import { taskCommandText } from "~/cli/format/tasks";
import { createEngine, type WorkspaceStoreBundle } from "~/create";
import { MemoryAutomationStore } from "~/lib/automation/store";
import { MemoryWorkspaceRecords } from "~/lib/events/records";
import { MemoryExecutionStore } from "~/lib/execution-store";
import { readExecutionFromStores } from "~/lib/executions";
import { MemoryProviderStore } from "~/lib/providers/store";
import { MemoryRunStore } from "~/lib/run-store";
import type { ActivityRecord, ActivityStore } from "~/lib/sandbox/activities";
import { MemoryDeferredApprovalStore } from "~/lib/sandbox/deferred-approvals";
import { MemoryTriggerStore } from "~/lib/trigger-store";
import { MemoryUsageStore } from "~/lib/usage-store";
import { runStoreEffect } from "~/lib/workflow-runs";

function memoryActivityStore(): ActivityStore {
  const entries = new Map<string, ActivityRecord>();
  return {
    load: () => Promise.resolve([...entries.values()]),
    put: (key, record) => {
      entries.set(key, record);
      return Promise.resolve();
    },
  };
}

function memoryGrantStorage(): GrantDocumentStorage {
  let saved: string | undefined;
  return {
    transact: (apply) => {
      const outcome = apply(saved);
      if (outcome.next !== undefined) {
        saved = outcome.next;
      }
      return Promise.resolve(outcome.result);
    },
  };
}

describe("store seams", () => {
  test("readExecutionFromStores projects an ExecutionRun from RunStore and ExecutionStore without SQLite", async () => {
    const runStore = new MemoryRunStore();
    const executionStore = new MemoryExecutionStore();
    const queue = await runStore.open(() => undefined);
    const jobId = "jb-1" as JobId;
    const runId = "rn-1" as RunId;
    const createdAt = Date.parse("2026-06-01T10:00:00.000Z");

    await runStoreEffect(
      queue.commit({
        jobs: [
          {
            createdAt,
            handler: { name: "build" },
            id: jobId,
            input: { target: "app" },
            links: { source: "cli" },
            policy: {},
            pool: DEFAULT_POOL,
            state: {
              completedAt: createdAt + 2000,
              kind: "complete",
              output: { ok: true },
              runId,
            },
          },
        ],
        runs: [
          {
            attempt: 1,
            id: runId,
            jobId,
            pool: DEFAULT_POOL,
            revision: 2,
            startedAt: createdAt + 1000,
            state: {
              completedAt: createdAt + 2000,
              kind: "complete",
              output: { ok: true },
            },
          },
        ],
      })
    );
    await executionStore.progress(
      runId,
      { step: "done" },
      "2026-06-01T10:00:03.000Z"
    );

    const record = await readExecutionFromStores(
      runStore,
      executionStore,
      runId
    );
    expect(record).toMatchObject({
      id: runId,
      jobId,
      kind: "workflow",
      name: "build",
      progress: { step: "done" },
      source: "cli",
      status: "complete",
    });
    expect(
      await readExecutionFromStores(runStore, executionStore, "rn-missing")
    ).toBeNull();
  });

  test("createEngine accepts an injected WorkspaceStoreBundle without touching SQLite", async () => {
    const stores: WorkspaceStoreBundle = {
      activities: memoryActivityStore(),
      approvals: new MemoryDeferredApprovalStore(),
      artifacts: new MemoryArtifactStore(),
      automations: new MemoryAutomationStore(),
      containers: new MemoryContainerStore(),
      executions: new MemoryExecutionStore(),
      grants: memoryGrantStorage(),
      providers: new MemoryProviderStore(),
      records: new MemoryWorkspaceRecords(),
      runs: new MemoryRunStore(),
      sessions: new MemorySessionStore(),
      triggers: new MemoryTriggerStore(),
      usage: new MemoryUsageStore(),
      workspaces: new MemoryWorkspaceStore(),
    };
    const engine = createEngine({
      catalog: new Catalog(),
      dry: false,
      print: () => undefined,
      root: "/tmp/marbles-store-bundle-test",
      stores,
      workspaceId: "ws-bundle",
    });
    try {
      expect(engine.sessions).toBe(stores.sessions);
      expect(engine.triggers).toBe(stores.triggers);
      expect(engine.taskStore).toBe(stores.records?.taskStore);
    } finally {
      await engine.dispose();
    }
  });

  test("taskCommandText handles pages where total is undefined", () => {
    expect(taskCommandText({ kind: "list", query: {} }, { items: [] })).toBe(
      "no tasks"
    );

    const sample = {
      createdAt: "2026-06-01T00:00:00.000Z",
      description: null,
      id: taskId("tk-1"),
      metadata: {},
      parentId: null,
      settledAt: null,
      status: "open" as const,
      tags: [],
      title: "Sample",
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    expect(
      taskCommandText(
        { kind: "list", query: {} },
        { items: [sample], nextCursor: 1 }
      )
    ).toBe("tk-1  open  Sample\n1 shown");
  });
});
