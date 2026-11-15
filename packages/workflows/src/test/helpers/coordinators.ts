import { ExecutionCoordinator } from "../../index";
import type { WorkflowStore } from "../../store/index";
import { MemoryWorkflowStore } from "../../store/memory";
import { SqliteWorkflowStore } from "../../store/sqlite";
import { libsqlDatabases } from "./sqlite";
import { FaultyWorkflowStore } from "./workflow-stores";

/** A coordinator over fresh storage, and every commit the storage refused. */
export interface OpenedCoordinator {
  readonly coordinator: ExecutionCoordinator;
  /** Errors the store rejected a commit with; the runtime may swallow them. */
  readonly failures: readonly unknown[];
  /** The storage under `coordinator`, for a test that builds its own. */
  readonly store: WorkflowStore;
}

/**
 * Each kind of storage a coordinator runs over in tests: the memory store,
 * and the SQLite store on `:memory:` and on a file. Call at the top of a
 * test file: the SQLite databases close after each test.
 */
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
