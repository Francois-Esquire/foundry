import type { Page } from "@foundry/core/pagination";
import { pageLimit, sliceRanked } from "@foundry/lib/pagination";
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
import type { TaskSnapshot, TaskStore, TaskStoreWrite } from "./store";
import { MemoryTaskStore } from "./store";
import type {
  DepthOptions,
  ReadyQuery,
  TagQuery,
  Task,
  TaskAvailability,
  TaskId,
  TaskNode,
  TaskQuery,
  TaskRelations,
  TaskStatus,
} from "./types";
import { taskId } from "./types";

export interface TasksOptions {
  readonly clock?: () => Date;
  /**
   * Whether something outside this package still references the task — a
   * workflows Job carrying its id in `links`, say. `remove` refuses while it
   * does. Nothing is referenced when omitted.
   */
  readonly inUse?: (id: TaskId) => Promise<boolean>;
  /** Children wait for their parent to be started. Off by default. */
  readonly parentGate?: boolean;
  /** Persistence. Defaults to an in-memory store. */
  readonly store?: TaskStore;
}

export interface CreateOptions {
  readonly dependsOn?: readonly TaskRef[];
  readonly parent?: TaskRef;
}

/**
 * The backlog: what there is to do, what is ready, what is done.
 *
 * Reads project the store. Every mutation is one atomic `change` batch, run
 * one at a time in this process; the shorthands wrap a single operation.
 * Execution belongs elsewhere — a runner takes `ready()`, starts a task,
 * does the work through whatever runs it, and completes or cancels the task.
 */
export class Tasks {
  readonly #store: TaskStore;
  readonly #inUse: ((id: TaskId) => Promise<boolean>) | undefined;
  readonly #parentGate: boolean;
  readonly #clock: () => Date;
  #lastInstant = 0;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: TasksOptions = {}) {
    this.#store = options.store ?? new MemoryTaskStore();
    this.#inUse = options.inUse;
    this.#parentGate = options.parentGate ?? false;
    this.#clock = options.clock ?? (() => new Date());
  }

  /** One task, with `depth` levels of subtasks beneath it. */
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

  /** What there is: every task, oldest first, optionally by status or parent. */
  async list(query: TaskQuery = {}): Promise<Page<TaskNode, number>> {
    const depth = requireDepth(query.depth);
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

  /** What is next: open tasks nothing holds back, oldest first. */
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

  /** Direct children, each with `depth` further levels beneath it. */
  async children(
    id: string,
    options: DepthOptions = {}
  ): Promise<readonly TaskNode[]> {
    const depth = requireDepth(options.depth);
    const { tasks } = await this.#snapshot();
    const parent = requireTask(tasks, id);
    const index = childrenOf(tasks);
    return expandAll(index.get(parent.id) ?? [], depth, index);
  }

  async dependencies(id: string): Promise<TaskRelations> {
    const snapshot = await this.#snapshot();
    const task = requireTask(snapshot.tasks, id);
    const byId = new Map(snapshot.tasks.map((item) => [item.id, item]));
    const pick = (ids: readonly TaskId[]): readonly Task[] =>
      ordered(ids.flatMap((item) => byId.get(item) ?? []));
    return {
      dependents: pick(
        snapshot.dependencies
          .filter((edge) => edge.dependsOnId === task.id)
          .map((edge) => edge.taskId)
      ),
      dependsOn: pick(
        snapshot.dependencies
          .filter((edge) => edge.taskId === task.id)
          .map((edge) => edge.dependsOnId)
      ),
    };
  }

  /** Applies every operation or none. Serialized with other mutations. */
  change(change: TaskChange): Promise<TaskChangeResult> {
    return this.#mutation(async (store) => {
      const snapshot = await this.#snapshot(store);
      // Instants only ever move past what the store held when this write
      // began, so writes that run one after another never share a token, across
      // instances and restarts too. Writes from two instances that overlap can.
      this.#lastInstant = Math.max(this.#lastInstant, latestInstant(snapshot));
      const applied = applyChange(snapshot, change, () => this.#now());
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

  /**
   * The one deletion, deliberately outside the batch language. Refuses while
   * children exist or the host still references the task; drops dependency
   * edges in both directions.
   *
   * The host's `inUse` is asked outside the store's transaction, so it may
   * read or write the store through another `Tasks`. The task, its token, and
   * its children are checked again inside the transaction, against the store
   * as it is then, and the removal is refused if any check now fails.
   */
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
      dropped
    );
    await store.commit(event === undefined ? write : { ...write, event });
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

  /** One operation; the batch always reports the task it named. */
  async #single(id: string, operation: TaskOperation): Promise<Task> {
    const result = await this.change({ operations: [operation] });
    const task = result.tasks.find((item) => item.id === id);
    if (task === undefined) {
      throw new TaskError("not_found", `Task ${id} not found`);
    }
    return task;
  }

  /** Strictly increasing instants, so two writes never share a token. */
  #now(): string {
    const instant = Math.max(this.#clock().getTime(), this.#lastInstant + 1);
    this.#lastInstant = instant;
    return new Date(instant).toISOString();
  }

  /** Every task as read, with `tags` on records written before there were any. */
  async #snapshot(store: TaskStore = this.#store): Promise<TaskSnapshot> {
    const snapshot = await store.snapshot();
    return { ...snapshot, tasks: snapshot.tasks.map(withTags) };
  }

  /**
   * One read-modify-write: serialized in this instance, and exclusive in the
   * store when it offers transactions, so another `Tasks` over the same store
   * cannot write between the read and the commit.
   */
  #mutation<T>(work: (store: TaskStore) => Promise<T>): Promise<T> {
    return this.#serialized(() => this.#transaction(work));
  }

  /** `work` exclusive in the store when it offers transactions. */
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

/** The one field a shorthand takes from its token; the operation itself comes
 *  from the shorthand's own arguments. */
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

/** The task `remove` may delete: present, at the token if one is given, and childless. */
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

/** A record stored before tasks had tags has none. */
function withTags(task: Task): Task {
  return Array.isArray(task.tags) ? task : { ...task, tags: [] };
}

/** True when `task` has every tag in `query.all` and one in a nonempty `query.any`. */
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

/** Children by parent, each sibling list oldest first. */
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

/** The latest instant the store holds; new instants move strictly past it. */
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
