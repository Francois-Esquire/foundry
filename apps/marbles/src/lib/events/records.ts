import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMissingPath, writeFileAtomic } from "@foundry/lib/atomic-file";
import type { JsonValue } from "@foundry/lib/json";
import type {
  Task,
  TaskDependency,
  TaskSnapshot,
  TaskStore,
  TaskStoreWrite,
} from "@foundry/tasks";
import { TASK_STATUSES, taskId } from "@foundry/tasks";
import { z } from "zod";
import type { Source } from "~/lib/events/source";
import { sourceKey, sourceNamed, TASKS } from "~/lib/events/source";
import type { Lock } from "~/lib/state/locks";
import { acquireLock } from "~/lib/state/locks";

/**
 * A workspace's durable records: its tasks, and the stream of every item
 * their changes emitted, each with the hashes of the handlers that completed
 * it. Both live in one document, so a task change and the item it emits are
 * written together, by one rename, or not at all. On disk that is
 * `<state>/tasks.json`; without a state dir it is memory, which lasts as long
 * as this object.
 *
 * Every change emits an item, whether or not anything observes it yet, and
 * nothing here removes an item or a recorded hash: an observer declared
 * later receives what was emitted before it, and what was delivered stays
 * recorded as delivered. Nothing compacts the stream, so it grows with every
 * change.
 *
 * Every write takes one turn, task commits and delivered hashes alike, and
 * applies to the records as they are when its turn comes, so neither can
 * overwrite the other. A write is applied to a copy, persisted, and only then
 * made current: one that fails leaves nothing visible. No handler runs inside
 * a turn.
 *
 * One process owns a state dir's records at a time, from the first read until
 * `close`, through `<state>/locks/tasks`. A document that cannot be read is an
 * error, never an empty start; it is left as it is.
 */

/** An item as delivery reads it: detached, with its source resolved. */
export interface StreamItem {
  /** Hashes of the handlers that completed it. */
  readonly delivered: readonly string[];
  readonly id: string;
  readonly payload: unknown;
  readonly source: symbol;
}

/** Another process owns these records; nothing here may read or write them. */
export class RecordsHeldError extends Error {
  override readonly name = "RecordsHeldError";
}

export interface WorkspaceRecordsOptions {
  /** The workspace state dir. Omit to keep the records in memory. */
  readonly dir?: string;
  /** Called after a turn whose write emitted an item, once the turn is over. */
  readonly emitted?: () => void;
}

const FILE = "tasks.json";
const LOCK = "tasks";
const VERSION = 1;

const taskSchema = z.looseObject({
  createdAt: z.string(),
  description: z.string().nullable(),
  id: z.string().transform(taskId),
  metadata: z.record(z.string(), z.json()),
  parentId: z.string().transform(taskId).nullable(),
  settledAt: z.string().nullable(),
  status: z.enum(TASK_STATUSES),
  // Absent on a record written before tasks had tags; Tasks reads it as none.
  tags: z.array(z.string()).optional(),
  title: z.string(),
  updatedAt: z.string(),
});

const dependencySchema = z.looseObject({
  dependsOnId: z.string().transform(taskId),
  taskId: z.string().transform(taskId),
});

const itemSchema = z.looseObject({
  delivered: z.array(z.string()),
  id: z.string().min(1),
  payload: z.json(),
  source: z.string().min(1),
});

const documentSchema = z.strictObject({
  dependencies: z.array(dependencySchema),
  items: z.array(itemSchema),
  tasks: z.array(taskSchema),
  version: z.literal(VERSION),
});

interface StoredItem {
  delivered: string[];
  readonly id: string;
  readonly payload: JsonValue;
  /** The source's key; see `source.ts`. */
  readonly source: string;
}

interface Records {
  dependencies: TaskDependency[];
  items: StoredItem[];
  tasks: Task[];
}

/** What a write did: nothing, or changed the records, emitting or not. */
type Outcome = "unchanged" | "changed" | "emitted";

export class WorkspaceRecords {
  /**
   * The tasks, through the `@foundry/tasks` store seam. Each commit emits
   * its change into the stream in the same write; `transaction` holds the
   * turn for a whole read-modify-write.
   */
  readonly taskStore: TaskStore;
  readonly #path: string | undefined;
  readonly #dir: string | undefined;
  readonly #options: WorkspaceRecordsOptions;
  #state: Records | undefined;
  #opening: Promise<Records> | undefined;
  #lock: Lock | undefined;
  #phase: "open" | "closed" = "open";
  #turn: Promise<unknown> = Promise.resolve();
  /** Items emitted by writes whose turn has not ended yet. */
  #unannounced = 0;

  constructor(options: WorkspaceRecordsOptions = {}) {
    this.#options = options;
    this.#dir = options.dir;
    this.#path =
      options.dir === undefined ? undefined : join(options.dir, FILE);
    const get = (records: Records, id: string): Task | null => {
      const task = records.tasks.find((item) => item.id === id);
      return task === undefined ? null : structuredClone(task);
    };
    // Inside a turn: reads see the records as committed, and the commit
    // applies without taking the turn again. A turn already waiting when
    // `close` began still finishes.
    const view: TaskStore = {
      commit: (write) =>
        this.#write((draft) => this.#applyTaskWrite(draft, write)),
      get: async (id) => get(await this.#open(), id),
      snapshot: async () => snapshotOf(await this.#open()),
    };
    this.taskStore = {
      commit: (write) => this.#exclusive(() => view.commit(write)),
      get: async (id) => get(await this.#read(), id),
      snapshot: async () => snapshotOf(await this.#read()),
      transaction: (work) => this.#exclusive(() => work(view)),
    };
  }

  /** Every item whose source is defined here, oldest first. */
  async pending(): Promise<readonly StreamItem[]> {
    const { items } = await this.#read();
    return items.flatMap((item) => {
      const source = sourceNamed(item.source);
      return source === undefined
        ? []
        : [
            {
              delivered: [...item.delivered],
              id: item.id,
              payload: structuredClone(item.payload),
              source,
            },
          ];
    });
  }

  /** Record that the handler with `hash` completed the item, beside every hash already there. */
  deliver(id: string, hash: string): Promise<void> {
    return this.#exclusive(() =>
      this.#write((draft) => {
        const item = draft.items.find((candidate) => candidate.id === id);
        if (item === undefined || item.delivered.includes(hash)) {
          return "unchanged";
        }
        item.delivered.push(hash);
        return "changed";
      })
    );
  }

  /** Take ownership and read the records now, so a problem surfaces here. */
  async open(): Promise<void> {
    await this.#read();
  }

  /**
   * Refuse new reads and writes, let the writes already waiting finish, then
   * give up ownership for good.
   */
  async close(): Promise<void> {
    this.#phase = "closed";
    await this.#turn;
    await this.#opening?.catch(() => undefined);
    this.#lock?.release();
    this.#lock = undefined;
    this.#state = undefined;
  }

  #read(): Promise<Records> {
    return this.#phase === "closed"
      ? Promise.reject(new Error("workspace records are closed"))
      : this.#open();
  }

  #open(): Promise<Records> {
    if (this.#state !== undefined) {
      return Promise.resolve(this.#state);
    }
    this.#opening ??= this.#load().then(
      (state) => {
        this.#state = state;
        return state;
      },
      (error: unknown) => {
        // Nothing was taken; the next read tries again.
        this.#opening = undefined;
        throw error;
      }
    );
    return this.#opening;
  }

  async #load(): Promise<Records> {
    const dir = this.#dir;
    const path = this.#path;
    if (dir === undefined || path === undefined) {
      return { dependencies: [], items: [], tasks: [] };
    }
    const lock = acquireLock(dir, LOCK);
    if (!("release" in lock)) {
      throw new RecordsHeldError(
        `the tasks of this workspace (${path}) are in use by ${lock.holder}`
      );
    }
    try {
      const records = await readRecords(path);
      this.#lock = lock;
      return records;
    } catch (error) {
      lock.release();
      throw error;
    }
  }

  /** Run `work` alone among writes, then tell delivery about anything it emitted. */
  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.#phase === "closed") {
      return Promise.reject(new Error("workspace records are closed"));
    }
    const run = this.#turn.then(work);
    this.#turn = run.catch(() => undefined);
    return run.finally(() => {
      if (this.#unannounced > 0) {
        this.#unannounced = 0;
        this.#options.emitted?.();
      }
    });
  }

  /** Apply `mutate` to a copy, persist the copy, and only then make it current. */
  async #write(mutate: (draft: Records) => Outcome): Promise<void> {
    const draft = structuredClone(await this.#open());
    const outcome = mutate(draft);
    if (outcome === "unchanged") {
      return;
    }
    if (this.#path !== undefined) {
      await writeFileAtomic(
        this.#path,
        `${JSON.stringify({ version: VERSION, ...draft }, null, 2)}\n`,
        { createDirectory: true, fsync: true }
      );
    }
    this.#state = draft;
    if (outcome === "emitted") {
      this.#unannounced += 1;
    }
  }

  #applyTaskWrite(draft: Records, write: TaskStoreWrite): Outcome {
    const empty =
      write.event === undefined &&
      [
        write.deleteTasks,
        write.deleteDependencies,
        write.putTasks,
        write.putDependencies,
      ].every((list) => (list?.length ?? 0) === 0);
    if (empty) {
      return "unchanged";
    }
    const tasks = new Map(draft.tasks.map((task) => [task.id, task]));
    const edges = new Map(
      draft.dependencies.map((edge) => [edgeKey(edge), edge])
    );
    for (const id of write.deleteTasks ?? []) {
      tasks.delete(id);
    }
    for (const edge of write.deleteDependencies ?? []) {
      edges.delete(edgeKey(edge));
    }
    for (const task of write.putTasks ?? []) {
      tasks.set(task.id, structuredClone(task));
    }
    for (const edge of write.putDependencies ?? []) {
      edges.set(edgeKey(edge), { ...edge });
    }
    draft.tasks = [...tasks.values()];
    draft.dependencies = [...edges.values()];
    if (write.event === undefined) {
      return "changed";
    }
    this.#emit(draft, TASKS, write.event);
    return "emitted";
  }

  /** Add an item for `payload` to the stream in this write, undelivered. */
  #emit<T>(draft: Records, source: Source<T>, payload: NoInfer<T>): void {
    const key = sourceKey(source);
    if (key === undefined) {
      throw new Error(`${String(source)} is not a defined source`);
    }
    draft.items.push({
      delivered: [],
      id: randomUUID(),
      payload: structuredClone(payload) as JsonValue,
      source: key,
    });
  }
}

function edgeKey(edge: TaskDependency): string {
  return JSON.stringify([edge.taskId, edge.dependsOnId]);
}

function snapshotOf(records: Records): TaskSnapshot {
  return {
    dependencies: records.dependencies.map((edge) => ({ ...edge })),
    tasks: records.tasks.map((task) => structuredClone(task)),
  };
}

/** The records at `path`; none when it does not exist; an error when it is not records. */
async function readRecords(path: string): Promise<Records> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingPath(error)) {
      return { dependencies: [], items: [], tasks: [] };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw unreadable(path, String(error));
  }
  const result = documentSchema.safeParse(parsed);
  if (!result.success) {
    throw unreadable(path, z.prettifyError(result.error));
  }
  const { dependencies, items, tasks } = result.data;
  return {
    dependencies: dependencies as TaskDependency[],
    items: items as StoredItem[],
    // A stored record keeps the fields it has; Tasks fills in missing tags.
    tasks: tasks as unknown as Task[],
  };
}

function unreadable(path: string, detail: string): Error {
  return new Error(
    `${path} does not hold Marbles task records, so it was left as it is; fix or move it to go on: ${detail}`
  );
}
