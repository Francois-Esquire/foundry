import type { Task, TaskId, TaskSnapshot, TaskStoreWrite } from "../schema";

export type { TaskSnapshot, TaskStoreWrite } from "../schema";

export interface TaskStore {
  commit: (write: TaskStoreWrite) => Promise<void>;
  get: (id: TaskId) => Promise<Task | null>;
  snapshot: () => Promise<TaskSnapshot>;
  transaction?: <T>(work: (view: TaskStore) => Promise<T>) => Promise<T>;
}
