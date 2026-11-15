import type { Task, TaskId, TaskSnapshot, TaskStoreWrite } from "../schema";

// `./store` has always exported these records; they are defined in `./schema`.
export type { TaskSnapshot, TaskStoreWrite } from "../schema";

/**
 * The persistence seam. A store keeps tasks and dependency edges and applies
 * one write atomically. It enforces nothing: unique ids, acyclic edges,
 * status transitions, and tokens are the package's rules, checked before a
 * write reaches the store. Values crossing this seam are detached.
 *
 * `@foundry/tasks/store/memory` and `@foundry/tasks/store/sqlite` implement
 * it; `@foundry/tasks/testing/store` is the suite every implementation passes.
 */
export interface TaskStore {
  commit: (write: TaskStoreWrite) => Promise<void>;
  get: (id: TaskId) => Promise<Task | null>;
  snapshot: () => Promise<TaskSnapshot>;
  /**
   * Runs one read-modify-write so that no other write to the store lands
   * between its reads and its commit, from any `Tasks` over the store. `work`
   * reads and commits through `view` only. Without it, mutations are
   * serialized per `Tasks` instance and no further.
   */
  transaction?: <T>(work: (view: TaskStore) => Promise<T>) => Promise<T>;
}
