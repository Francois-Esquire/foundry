/**
 * Every records' `taskStore` is a `TaskStore`, held to the same suite as
 * the package's stores, and owns each write from the moment `commit` is
 * called: the tasks it keeps and the change it records are the write as it
 * stood then, whatever the caller does with it afterwards.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Task,
  TaskEvent,
  TaskStore,
  TaskStoreWrite,
} from "@foundry/tasks";
import { taskId } from "@foundry/tasks";
import { describeTaskStore } from "@foundry/tasks/testing/store";
import { afterAll, describe, expect, it } from "vitest";
import { openWorkspaceRecords } from "~/database/managed";
import { DatabaseWorkspaceRecords } from "~/database/tasks";
import type { WorkspaceRecords } from "~/lib/events/records";
import { MemoryWorkspaceRecords } from "~/lib/events/records";
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";

const opened: WorkspaceRecords[] = [];
const machines: TestMachine[] = [];

afterAll(async () => {
  await Promise.all(opened.splice(0).map((records) => records.close()));
  for (const machine of machines.splice(0)) {
    machine.close();
  }
});

/** One records per scope, from `make`, kept to be closed after the file. */
function perScope(
  make: (scope: string) => WorkspaceRecords
): (scope: string) => WorkspaceRecords {
  const records = new Map<string, WorkspaceRecords>();
  return (scope) => {
    let found = records.get(scope);
    if (found === undefined) {
      found = make(scope);
      records.set(scope, found);
      opened.push(found);
    }
    return found;
  };
}

/** Fresh storage of each kind, a records per scope over it. */
const KINDS: readonly {
  readonly name: string;
  readonly open: () => Promise<(scope: string) => WorkspaceRecords>;
}[] = [
  {
    name: "MemoryWorkspaceRecords",
    open: () => Promise.resolve(perScope(() => new MemoryWorkspaceRecords())),
  },
  {
    name: "DatabaseWorkspaceRecords",
    async open() {
      const machine = await testMachine();
      machines.push(machine);
      return perScope(
        (scope) =>
          new DatabaseWorkspaceRecords({
            database: machine.database.database,
            scope,
          })
      );
    },
  },
  {
    name: "openWorkspaceRecords",
    open() {
      const state = mkdtempSync(join(tmpdir(), "marbles-managed-"));
      return Promise.resolve(
        perScope((workspaceId) => openWorkspaceRecords({ state, workspaceId }))
      );
    },
  },
];

for (const kind of KINDS) {
  describeTaskStore(kind.name, async () => {
    const records = await kind.open();
    return (scope): TaskStore => records(scope).taskStore;
  });
}

/** A write creating one task titled `title`, with the change it makes. */
function creating(title: string): TaskStoreWrite & { events: TaskEvent[] } {
  const at = "2026-11-14T00:00:00.000Z";
  const task: Task = {
    createdAt: at,
    description: null,
    id: taskId("tk-00000001"),
    metadata: {},
    parentId: null,
    settledAt: null,
    status: "open",
    tags: [],
    title,
    updatedAt: at,
  };
  return {
    events: [
      {
        at: task.createdAt,
        dependencies: { added: [], removed: [] },
        id: `event-${task.id}`,
        tasks: [{ after: structuredClone(task), before: null, id: task.id }],
        type: "tasks.changed",
      },
    ],
    putTasks: [task],
  };
}

/** Change everything in `write` a caller could still reach. */
function tamper(write: TaskStoreWrite & { events: TaskEvent[] }): void {
  const [task] = write.putTasks ?? [];
  if (task !== undefined) {
    (task as { title: string }).title = "Changed";
  }
  const [delta] = write.events[0]?.tasks ?? [];
  if (delta?.after) {
    (delta.after as { title: string }).title = "Changed";
  }
}

/** The title kept, and the title of every change recorded. */
async function kept(records: WorkspaceRecords) {
  const { tasks } = await records.taskStore.snapshot();
  const changes = await records.log.read({ after: 0, source: "tasks" });
  return {
    changes: changes.map(
      (change) => (change.fact as TaskEvent).tasks[0]?.after?.title
    ),
    tasks: tasks.map((task) => task.title),
  };
}

const AS_CALLED = { changes: ["Kept"], tasks: ["Kept"] };

describe("records own a write from the call", () => {
  for (const kind of KINDS) {
    describe(kind.name, () => {
      it("keeps the write as called though the caller changes it at once", async () => {
        const records = (await kind.open())("ws");
        const write = creating("Kept");
        const committed = records.taskStore.commit(write);
        tamper(write);
        await committed;
        expect(await kept(records)).toEqual(AS_CALLED);
      });

      it("keeps the write as called though it waits behind a transaction", async () => {
        const records = (await kind.open())("ws");
        const { transaction } = records.taskStore;
        if (transaction === undefined) {
          throw new Error("the store offers no transaction");
        }
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let entered: () => void = () => undefined;
        const inside = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const holding = transaction(async () => {
          entered();
          await held;
        });
        await inside;
        const write = creating("Kept");
        const committed = records.taskStore.commit(write);
        tamper(write);
        release();
        await holding;
        await committed;
        expect(await kept(records)).toEqual(AS_CALLED);
      });

      it("keeps a write through a transaction's view as called", async () => {
        const records = (await kind.open())("ws");
        const { transaction } = records.taskStore;
        if (transaction === undefined) {
          throw new Error("the store offers no transaction");
        }
        await transaction(async (view) => {
          const write = creating("Kept");
          const committed = view.commit(write);
          tamper(write);
          await committed;
        });
        expect(await kept(records)).toEqual(AS_CALLED);
      });
    });
  }
});
