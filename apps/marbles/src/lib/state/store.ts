import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import { writeJson } from "~/lib/state/json";
import type { HeldLock, Lock } from "~/lib/state/locks";
import { acquireLock } from "~/lib/state/locks";

/**
 * Where the scheduler, monitors and agent-created triggers keep what must
 * outlive one tick: JSON documents by collection and key, and named locks.
 * An engine owns one: on disk under its state dir, or in memory when nothing
 * should survive the process. A host may hand the engine its own.
 *
 * - `schedules`: each trigger's last tick, read by `status` and the loop.
 * - `monitors`: what each monitor last saw, and a launch it handed out.
 * - `automations`: the triggers agents created, one record per id.
 */

export type StateCollection = "automations" | "monitors" | "schedules";

/** One document in a collection, as `list` finds it. */
export type StoredDocument = {
  readonly key: string;
  /** When it was last written, in ms since the epoch. */
  readonly modified: number;
} & (
  | { readonly error?: undefined; readonly value: unknown }
  /** The document exists but could not be read. */
  | { readonly error: string; readonly value?: undefined }
);

/**
 * Keys and lock names become file names, so each must be one plain name:
 * not empty, not `.` or `..`, and without a path separator or NUL.
 */
const UNSAFE_NAME = /[/\\\0]/;

function plainName(kind: string, name: string): string {
  if (name === "" || name === "." || name === ".." || UNSAFE_NAME.test(name)) {
    throw new Error(
      `state ${kind} ${JSON.stringify(name)} must be a plain name: not empty, "." or "..", and without "/", "\\" or NUL`
    );
  }
  return name;
}

export interface StateStore {
  /** Every document in the collection; one that cannot be read carries its error. */
  list(collection: StateCollection): readonly StoredDocument[];
  /**
   * The named lock, or who holds it now. One holder at a time across every
   * caller that shares the store, in this process or another.
   */
  lock(name: string): Lock | HeldLock;
  /** `undefined` when missing or unreadable: state is advisory, never fatal. */
  read(collection: StateCollection, key: string): unknown;
  remove(collection: StateCollection, key: string): void;
  /**
   * Changes whenever a document in the collection is written or removed, by
   * any process sharing the store; a reader skips re-reading while it holds.
   */
  revision(collection: StateCollection): string;
  write(
    collection: StateCollection,
    key: string,
    value: Readonly<Record<string, unknown>>
  ): void;
}

const JSON_SUFFIX = ".json";

/**
 * `<dir>/<collection>/<key>.json` and `<dir>/locks/<name>`, the layout
 * `status` reads without an engine. Writes are temp-and-rename, so a
 * concurrent reader never sees half a document.
 */
export class JsonStateStore implements StateStore {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  #path(collection: StateCollection, key: string): string {
    return join(
      this.#dir,
      collection,
      `${plainName("key", key)}${JSON_SUFFIX}`
    );
  }

  #files(collection: StateCollection): string[] {
    const directory = join(this.#dir, collection);
    return existsSync(directory)
      ? readdirSync(directory)
          .filter((name) => name.endsWith(JSON_SUFFIX))
          .sort()
      : [];
  }

  list(collection: StateCollection): readonly StoredDocument[] {
    return this.#files(collection).flatMap((file): StoredDocument[] => {
      const key = file.slice(0, -JSON_SUFFIX.length);
      const path = join(this.#dir, collection, file);
      try {
        const { mtimeMs } = statSync(path);
        try {
          return [
            {
              key,
              modified: mtimeMs,
              value: JSON.parse(readFileSync(path, "utf8")),
            },
          ];
        } catch (error) {
          return [{ error: String(error), key, modified: mtimeMs }];
        }
      } catch {
        // Removed between the listing and the read.
        return [];
      }
    });
  }

  lock(name: string): Lock | HeldLock {
    return acquireLock(this.#dir, plainName("lock name", name));
  }

  read(collection: StateCollection, key: string): unknown {
    const path = this.#path(collection, key);
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
  }

  remove(collection: StateCollection, key: string): void {
    rmSync(this.#path(collection, key), { force: true });
  }

  /**
   * Each file's name, inode, mtime and size: a rename-into-place (every
   * write here) gives a new inode even within one millisecond, and an
   * in-place edit moves the mtime or size.
   */
  revision(collection: StateCollection): string {
    return this.#files(collection)
      .map((file) => {
        try {
          const { ino, mtimeMs, size } = statSync(
            join(this.#dir, collection, file)
          );
          return `${file}:${String(ino)}:${String(mtimeMs)}:${String(size)}`;
        } catch {
          return "";
        }
      })
      .join("\n");
  }

  write(
    collection: StateCollection,
    key: string,
    value: Readonly<Record<string, unknown>>
  ): void {
    writeJson(this.#path(collection, key), value);
  }
}

/**
 * The same contract held in this process: documents are copied in and out,
 * so a caller never shares a reference with the store, and a lock held here
 * is held for every caller of this store.
 */
export class InMemoryStateStore implements StateStore {
  readonly #documents = new Map<
    StateCollection,
    Map<string, { readonly modified: number; readonly value: unknown }>
  >();
  readonly #revisions = new Map<StateCollection, number>();
  readonly #locks = new Set<string>();

  #collection(collection: StateCollection) {
    let documents = this.#documents.get(collection);
    if (!documents) {
      documents = new Map();
      this.#documents.set(collection, documents);
    }
    return documents;
  }

  #changed(collection: StateCollection): void {
    this.#revisions.set(collection, (this.#revisions.get(collection) ?? 0) + 1);
  }

  list(collection: StateCollection): readonly StoredDocument[] {
    return [...this.#collection(collection)]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, { modified, value }]) => ({
        key,
        modified,
        value: structuredClone(value),
      }));
  }

  lock(name: string): Lock | HeldLock {
    plainName("lock name", name);
    if (this.#locks.has(name)) {
      return { holder: "this process" };
    }
    this.#locks.add(name);
    let held = true;
    return {
      release: () => {
        if (held) {
          held = false;
          this.#locks.delete(name);
        }
      },
    };
  }

  read(collection: StateCollection, key: string): unknown {
    return structuredClone(
      this.#collection(collection).get(plainName("key", key))?.value
    );
  }

  remove(collection: StateCollection, key: string): void {
    if (this.#collection(collection).delete(plainName("key", key))) {
      this.#changed(collection);
    }
  }

  revision(collection: StateCollection): string {
    return String(this.#revisions.get(collection) ?? 0);
  }

  write(
    collection: StateCollection,
    key: string,
    value: Readonly<Record<string, unknown>>
  ): void {
    this.#collection(collection).set(plainName("key", key), {
      modified: Date.now(),
      value: structuredClone(value),
    });
    this.#changed(collection);
  }
}
