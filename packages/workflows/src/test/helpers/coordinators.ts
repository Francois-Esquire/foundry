import { ExecutionCoordinator } from "../../index";
import type { WorkflowStore } from "../../store/index";
import { MemoryWorkflowStore } from "../../store/memory";
import { SqliteWorkflowStore } from "../../store/sqlite";
import { libsqlDatabases } from "./sqlite";
import { FaultyWorkflowStore } from "./workflow-stores";

export interface OpenedCoordinator {
  readonly coordinator: ExecutionCoordinator;
  readonly failures: readonly unknown[];
  readonly store: WorkflowStore;
}

export function coordinatorStores(): readonly [
  string,
  () => Promise<OpenedCoordinator>,
][] {
  const memory = libsqlDatabases("memory");
  const files = libsqlDatabases("file");
  const over = (store: MemoryWorkflowStore | SqliteWorkflowStore) => {
    const recorded = new FaultyWorkflowStore(store);
    return {
      coordinator: new ExecutionCoordinator({ store: recorded }),
      failures: recorded.failures,
      store: recorded,
    };
  };
  return [
    ["memory store", () => Promise.resolve(over(new MemoryWorkflowStore()))],
    [
      "SQLite store (:memory:)",
      async () =>
        over(
          new SqliteWorkflowStore({ database: await memory.open(), scope: "s" })
        ),
    ],
    [
      "SQLite store (file)",
      async () =>
        over(
          new SqliteWorkflowStore({ database: await files.open(), scope: "s" })
        ),
    ],
  ];
}
