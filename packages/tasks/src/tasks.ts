import type { Page } from "@foundry/core/pagination";
import { pageLimit, sliceRanked } from "@foundry/lib/pagination";
import type { TaskAvailability } from "./availability";
import { availabilityIn, readyTaskIds } from "./availability";
import { applyChange, changeEvent } from "./change";
import { TaskError } from "./errors";
import type {
  CreateTaskInput,
  TaskChange,
  TaskChangeResult,
  TaskOperation,
  TaskRef,
  TaskToken,
  UpdateTaskInput,
} from "./operations";
import type {
  DepthOptions,
  ReadyQuery,
  TagQuery,
  TaskNode,
  TaskQuery,
  TaskRelations,
} from "./queries";
import type {
  Task,
  TaskId,
  TaskSnapshot,
  TaskStatus,
  TaskStoreWrite,
} from "./schema";
import { taskId } from "./schema";
import type { TaskStore } from "./store/index";
import { MemoryTaskStore } from "./store/memory";

export interface TasksOptions {
  readonly clock?: () => Date;
  readonly id?: () => string;
  readonly inUse?: (id: TaskId) => Promise<boolean>;
  readonly parentGate?: boolean;
  readonly store?: TaskStore;
}

export interface CreateOptions {
  readonly dependsOn?: readonly TaskRef[];
  readonly parent?: TaskRef;
}

export class Tasks {
  readonly #store: TaskStore;
  readonly #inUse: ((id: TaskId) => Promise<boolean>) | undefined;
  readonly #parentGate: boolean;
  readonly #clock: () => Date;
  readonly #id: () => string;
  #lastInstant = 0;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: TasksOptions = {}) {
    this.#store = options.store ?? new MemoryTaskStore();
    this.#inUse = options.inUse;
    this.#parentGate = options.parentGate ?? false;
    this.#clock = options.clock ?? (() => new Date());
    this.#id = options.id ?? (() => crypto.randomUUID());
  }

  async get(id: string, options: DepthOptions = {}): Promise<TaskNode | null> {
    const depth = requireDepth(options.depth);
    if (depth === 0) {
      const task = await this.#store.get(taskId(id));
      return task === null ? null : withTags(task);
    }
    const { tasks } = await this.#snapshot();
    const task = tasks.find((item) => item.id === id);
    return task === undefined ? null : expand(task, depth, childrenOf(tasks));
  }

  async list(query: TaskQuery = {}): Promise<Page<TaskNode, number>> {
    const depth = requireDepth(query.depth);
    if (depth === 0 && this.#store.list !== undefined) {
      const listed = (
        await this.#store.list({
          ...(query.parentId === undefined ? {} : { parentId: query.parentId }),
          ...(query.status === undefined ? {} : { status: query.status }),
        })
      ).map(withTags);
      const matching = ordered(listed).filter((task) =>
        hasTags(task, query.tags)
      );
      return sliceRanked(matching, pageLimit(query.limit), query.cursor ?? 0);
    }
    const { tasks } = await this.#snapshot();
    const matching = ordered(tasks).filter(
      (task) =>
        (query.status === undefined || task.status === query.status) &&
        (query.parentId === undefined || task.parentId === query.parentId) &&
        hasTags(task, query.tags)
    );
    const page = sliceRanked(
      matching,
      pageLimit(query.limit),
      query.cursor ?? 0
    );
    if (depth === 0) {
      return page;
    }
    return { ...page, items: expandAll(page.items, depth, childrenOf(tasks)) };
  }

  async ready(query: ReadyQuery = {}): Promise<Page<Task, number>> {
    const snapshot = await this.#snapshot();
    const readyIds = readyTaskIds(snapshot, { parentGate: this.#parentGate });
    const ready = ordered(snapshot.tasks).filter(
      (task) => readyIds.has(task.id) && hasTags(task, query.tags)
    );
    return sliceRanked(ready, pageLimit(query.limit), query.cursor ?? 0);
  }

  async availability(id: string): Promise<TaskAvailability | null> {
    const snapshot = await this.#snapshot();
    return availabilityIn(snapshot, taskId(id), {
      parentGate: this.#parentGate,
    });
  }

  async children(
    id: string,
    options: DepthOptions = {}
  ): Promise<readonly TaskNode[]> {
    const depth = requireDepth(options.depth);
    if (depth === 0 && this.#store.children !== undefined) {
      return this.#transaction(async (store) => {
        const parent = await store.get(taskId(id));
        if (parent === null) {
          throw new TaskError("not_found", `Task ${id} not found`);
        }
        const rows =
          store.children === undefined
            ? (await this.#snapshot(store)).tasks.filter(
                (item) => item.parentId === parent.id
              )
            : await store.children(parent.id);
        return ordered(rows.map(withTags));
      });
    }
    const { tasks } = await this.#snapshot();
    const parent = requireTask(tasks, id);
    const index = childrenOf(tasks);
    return expandAll(index.get(parent.id) ?? [], depth, index);
  }

  async getWithRelations(
    id: string,
    options: DepthOptions = {}
  ): Promise<(TaskNode & TaskRelations) | null> {
    const depth = requireDepth(options.depth);
    if (depth === 0 && this.#store.dependenciesOf !== undefined) {
      return this.#transaction(async (store) => {
        const task = await store.get(taskId(id));
        if (task === null) {
          return null;
        }
        const relations = await this.#relationsFor(store, task.id);
        return { ...withTags(task), ...relations };
      });
    }
    const snapshot = await this.#snapshot();
    const task = snapshot.tasks.find((item) => item.id === id);
    if (task === undefined) {
      return null;
    }
    const node =
      depth === 0
        ? withTags(task)
        : expand(task, depth, childrenOf(snapshot.tasks));
    return { ...node, ...relationsOf(snapshot, task.id) };
  }

  async dependencies(id: string): Promise<TaskRelations> {
    if (this.#store.dependenciesOf !== undefined) {
      return this.#transaction(async (store) => {
        const task = await store.get(taskId(id));
        if (task === null) {
          throw new TaskError("not_found", `Task ${id} not found`);
        }
        return this.#relationsFor(store, task.id);
      });
    }
    const snapshot = await this.#snapshot();
    const task = requireTask(snapshot.tasks, id);
    return relationsOf(snapshot, task.id);
  }

  change(change: TaskChange): Promise<TaskChangeResult> {
    return this.#mutation(async (store) => {
      const snapshot = await this.#snapshot(store);
      this.#lastInstant = Math.max(this.#lastInstant, latestInstant(snapshot));
      const applied = applyChange(
        snapshot,
        change,
        () => this.#now(),
        { parentGate: this.#parentGate },
        this.#id
      );
      await store.commit(applied.write);
      return { changed: applied.changed, tasks: applied.tasks };
    });
  }

  async create(
    input: CreateTaskInput,
    options: CreateOptions = {}
  ): Promise<Task> {
    const key = "task";
    const result = await this.change({
      operations: [
        {
          input,
          key,
          kind: "task.create",
          ...(options.parent === undefined ? {} : { parent: options.parent }),
        },
        ...(options.dependsOn ?? []).map(
          (dependsOn): TaskOperation => ({
            dependsOn,
            kind: "dependency.add",
            task: { key },
          })
        ),
      ],
    });
    const created = result.changed.find((item) => item.key === key);
    const task = result.tasks.find((item) => item.id === created?.id);
    if (task === undefined) {
      throw new TaskError("invalid_operation", "create produced no task");
    }
    return task;
  }

  update(id: string, patch: UpdateTaskInput, token?: TaskToken): Promise<Task> {
    return this.#single(id, {
      kind: "task.update",
      patch,
      task: { id },
      ...expectation(token),
    });
  }

  start(id: string, token?: TaskToken): Promise<Task> {
    return this.#setStatus(id, "active", token);
  }

  complete(id: string, token?: TaskToken): Promise<Task> {
    return this.#setStatus(id, "completed", token);
  }

  cancel(id: string, token?: TaskToken): Promise<Task> {
    return this.#setStatus(id, "cancelled", token);
  }

  remove(id: string, token?: TaskToken): Promise<Task> {
    return this.#serialized(async () => {
      const checked = removable(await this.#snapshot(), id, token);
      if (this.#inUse !== undefined && (await this.#inUse(checked.id))) {
        throw new TaskError(
          "task_in_use",
          `Task ${checked.id} is still in use`
        );
      }
      return this.#transaction((store) =>
        this.#commitRemoval(store, id, token)
      );
    });
  }

  async #commitRemoval(
    store: TaskStore,
    id: string,
    token: TaskToken | undefined
  ): Promise<Task> {
    const snapshot = await this.#snapshot(store);
    const task = removable(snapshot, id, token);
    const dropped = snapshot.dependencies.filter(
      (edge) => edge.taskId === task.id || edge.dependsOnId === task.id
    );
    const write: TaskStoreWrite = {
      deleteDependencies: dropped,
      deleteTasks: [task.id],
    };
    const event = changeEvent(
      [{ after: null, before: task, id: task.id }],
      [],
      dropped,
      this.#now(),
      this.#id
    );
    await store.commit(
      event === undefined ? write : { ...write, events: [event] }
    );
    return task;
  }

  #setStatus(id: string, status: TaskStatus, token?: TaskToken): Promise<Task> {
    return this.#single(id, {
      kind: "task.set_status",
      status,
      task: { id },
      ...expectation(token),
    });
  }

  async #single(id: string, operation: TaskOperation): Promise<Task> {
    const result = await this.change({ operations: [operation] });
    const task = result.tasks.find((item) => item.id === id);
    if (task === undefined) {
      throw new TaskError("not_found", `Task ${id} not found`);
    }
    return task;
  }

  #now(): string {
    const instant = Math.max(this.#clock().getTime(), this.#lastInstant + 1);
    this.#lastInstant = instant;
    return new Date(instant).toISOString();
  }

  async #snapshot(store: TaskStore = this.#store): Promise<TaskSnapshot> {
    const snapshot = await store.snapshot();
    return { ...snapshot, tasks: snapshot.tasks.map(withTags) };
  }

  async #relationsFor(store: TaskStore, id: TaskId): Promise<TaskRelations> {
    const edges = (await store.dependenciesOf?.([id])) ?? [];
    const dependentIds = edges
      .filter((edge) => edge.dependsOnId === id)
      .map((edge) => edge.taskId);
    const dependsOnIds = edges
      .filter((edge) => edge.taskId === id)
      .map((edge) => edge.dependsOnId);
    const uniqueIds = [...new Set([...dependentIds, ...dependsOnIds])];
    const fetched = await Promise.all(
      uniqueIds.map(async (relatedId) => {
        const found = await store.get(relatedId);
        return found === null ? null : ([relatedId, withTags(found)] as const);
      })
    );
    const byId = new Map(
      fetched.filter(
        (entry): entry is readonly [TaskId, Task] => entry !== null
      )
    );
    const pick = (ids: readonly TaskId[]): readonly Task[] =>
      ordered(ids.flatMap((item) => byId.get(item) ?? []));
    return {
      dependents: pick(dependentIds),
      dependsOn: pick(dependsOnIds),
    };
  }

  #mutation<T>(work: (store: TaskStore) => Promise<T>): Promise<T> {
    return this.#serialized(() => this.#transaction(work));
  }

  #transaction<T>(work: (store: TaskStore) => Promise<T>): Promise<T> {
    const store = this.#store;
    return store.transaction === undefined
      ? work(store)
      : store.transaction(work);
  }

  #serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work, work);
    this.#tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

type ChildrenIndex = ReadonlyMap<TaskId, readonly Task[]>;

function expectation(token: TaskToken | undefined): TaskToken {
  return token?.expectedUpdatedAt === undefined
    ? {}
    : { expectedUpdatedAt: token.expectedUpdatedAt };
}

function compareCreation(a: Task, b: Task): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
}

function ordered(tasks: readonly Task[]): Task[] {
  return [...tasks].sort(compareCreation);
}

function removable(
  snapshot: TaskSnapshot,
  id: string,
  token: TaskToken | undefined
): Task {
  const task = requireTask(snapshot.tasks, id);
  if (
    token?.expectedUpdatedAt !== undefined &&
    token.expectedUpdatedAt !== task.updatedAt
  ) {
    throw new TaskError(
      "conflict",
      `Task ${task.id} changed at ${task.updatedAt}, expected ${token.expectedUpdatedAt}`
    );
  }
  const children = snapshot.tasks.filter((item) => item.parentId === task.id);
  if (children.length > 0) {
    throw new TaskError(
      "invalid_operation",
      `Task ${task.id} still has ${children.length} children; move or remove them first`
    );
  }
  return task;
}

function requireTask(tasks: readonly Task[], id: string): Task {
  const task = tasks.find((item) => item.id === id);
  if (task === undefined) {
    throw new TaskError("not_found", `Task ${id} not found`);
  }
  return task;
}

function withTags(task: Task): Task {
  return Array.isArray(task.tags) ? task : { ...task, tags: [] };
}

function hasTags(task: Task, query: TagQuery | undefined): boolean {
  const all = query?.all ?? [];
  const any = query?.any ?? [];
  return (
    all.every((tag) => task.tags.includes(tag)) &&
    (any.length === 0 || any.some((tag) => task.tags.includes(tag)))
  );
}

function requireDepth(depth: number | undefined): number {
  if (depth === undefined) {
    return 0;
  }
  if (!Number.isSafeInteger(depth) || depth < 0) {
    throw new RangeError("depth must be a non-negative integer");
  }
  return depth;
}

function childrenOf(tasks: readonly Task[]): ChildrenIndex {
  const index = new Map<TaskId, Task[]>();
  for (const task of ordered(tasks)) {
    if (task.parentId === null) {
      continue;
    }
    const siblings = index.get(task.parentId) ?? [];
    siblings.push(task);
    index.set(task.parentId, siblings);
  }
  return index;
}

function expand(task: Task, depth: number, index: ChildrenIndex): TaskNode {
  if (depth === 0) {
    return task;
  }
  return {
    ...task,
    subtasks: expandAll(index.get(task.id) ?? [], depth - 1, index),
  };
}

function expandAll(
  tasks: readonly Task[],
  depth: number,
  index: ChildrenIndex
): readonly TaskNode[] {
  return tasks.map((task) => expand(task, depth, index));
}

function relationsOf(snapshot: TaskSnapshot, id: TaskId): TaskRelations {
  const byId = new Map(snapshot.tasks.map((item) => [item.id, item]));
  const pick = (ids: readonly TaskId[]): readonly Task[] =>
    ordered(ids.flatMap((item) => byId.get(item) ?? []));
  return {
    dependents: pick(
      snapshot.dependencies
        .filter((edge) => edge.dependsOnId === id)
        .map((edge) => edge.taskId)
    ),
    dependsOn: pick(
      snapshot.dependencies
        .filter((edge) => edge.taskId === id)
        .map((edge) => edge.dependsOnId)
    ),
  };
}

function latestInstant(snapshot: TaskSnapshot): number {
  let latest = 0;
  for (const task of snapshot.tasks) {
    for (const value of [task.createdAt, task.updatedAt]) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) {
        latest = Math.max(latest, parsed);
      }
    }
  }
  return latest;
}
