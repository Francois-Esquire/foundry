import type {
  Task,
  TaskDependency,
  TaskId,
  TaskSnapshot,
  TaskStatus,
  TaskStoreWrite,
} from "../schema";

export type { TaskSnapshot, TaskStoreWrite } from "../schema";

export interface TaskStoreListQuery {
  readonly parentId?: TaskId | null;
  readonly status?: TaskStatus;
}

export interface TaskStore {
  children?: (parentId: TaskId) => Promise<readonly Task[]>;
  commit: (write: TaskStoreWrite) => Promise<void>;
  dependenciesOf?: (
    ids: readonly TaskId[]
  ) => Promise<readonly TaskDependency[]>;
  get: (id: TaskId) => Promise<Task | null>;
  list?: (query?: TaskStoreListQuery) => Promise<readonly Task[]>;
  snapshot: () => Promise<TaskSnapshot>;
  transaction?: <T>(work: (view: TaskStore) => Promise<T>) => Promise<T>;
}
