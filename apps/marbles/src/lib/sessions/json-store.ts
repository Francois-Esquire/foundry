import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  MessageMetadata,
  SessionMessage,
  SessionPart,
  SessionRecord,
} from "@foundry/agents/session";
import {
  MESSAGE_STATUSES,
  SESSION_ROLES,
  SESSION_STATUSES,
} from "@foundry/agents/session";
import type { SessionStore, SessionStoreWrite } from "@foundry/agents/store";
import { hasErrorCode, writeFileAtomic } from "@foundry/lib/atomic-file";
import { FileLockTimeoutError, withFileLock } from "@foundry/lib/file-lock";
import { KeyedQueue } from "@foundry/lib/keyed-queue";
import { z } from "zod";
import { isRecord } from "~/lib/state/json";

/**
 * Durable sessions as one JSON file each: `<dir>/<sessionId>.json` holding
 * the record and every message.
 *
 * The files are the truth, not this object: every read and every commit
 * reads the files again, so a session another process (the dashboard or
 * `roll`) wrote is seen, and a commit here does not overwrite what it
 * appended: a write is merged by id into each file as read.
 *
 * Every commit and every transaction holds the directory's turn: queued
 * within this process across store instances, and across processes under
 * `<dir>/.lock`, which holds the writer's pid. The store attempts to replace
 * a stale lock. A transaction stages its commits in memory and writes
 * nothing until `work` returns, so a `work` that throws leaves the files as
 * they were.
 *
 * What a commit or transaction changed is then published file by file, each
 * through a temp-and-rename. A change to one session file is atomic. A
 * change to several is atomic against every reader that takes the
 * directory's turn, but a crash part way through publishing can leave some
 * files written and others not. There is no journal: this store is
 * temporary, and the limit ends when sessions move to the Marbles database.
 *
 * A file that exists but does not read as a session is never overwritten:
 * reads skip it (and say so through `warn`), and commits throw until someone
 * repairs or removes it.
 */

interface SessionFile {
  readonly messages: SessionMessage[];
  readonly session: SessionRecord;
}

export interface JsonSessionStoreOptions {
  /** Told about each file skipped because it does not read as a session. */
  readonly warn?: (line: string) => void;
}

/** The shape the store relies on; unknown keys are kept, so a rewrite never drops them. */
const sessionFileSchema: z.ZodType<SessionFile> = z.object({
  messages: z.array(
    z.looseObject({
      createdAt: z.number(),
      id: z.string().min(1),
      metadata: z.custom<MessageMetadata>(isRecord).optional(),
      parts: z.array(
        z.custom<SessionPart>(
          (part) => isRecord(part) && typeof part.type === "string"
        )
      ),
      role: z.enum(SESSION_ROLES),
      sessionId: z.string(),
      status: z.enum(MESSAGE_STATUSES),
      summarized: z.boolean().optional(),
      updatedAt: z.number(),
    })
  ),
  session: z.looseObject({
    createdAt: z.number(),
    id: z.string().min(1),
    parentMessageId: z.string().nullable().optional(),
    parentSessionId: z.string().nullable().optional(),
    recursionDepth: z.number().optional(),
    status: z.enum(SESSION_STATUSES),
    title: z.string().nullable(),
    updatedAt: z.number(),
  }),
});

const SUFFIX = ".json";
/** A separator or NUL: an id holding one would not be a single file name. */
const NOT_A_FILE_NAME = /[/\\\0]/;
const LOCK_WAIT_MS = 10_000;
/** The directory's lock; not a session file, since it lacks the suffix. */
const LOCK = ".lock";

/**
 * Commits and transactions queued per directory. Process-wide on purpose: two stores over
 * one directory must still take turns, and the file lock they also take is
 * not reentrant, so it cannot order writers within one process.
 */
const queue = new KeyedQueue();

type Read =
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly reason: string }
  | { readonly kind: "session"; readonly file: SessionFile };

export class JsonSessionStore implements SessionStore {
  readonly #dir: string;
  readonly #warn: (line: string) => void;
  /** Message id → its session, as last seen here. A hint: always checked against the file. */
  readonly #owners = new Map<string, string>();

  constructor(dir: string, options: JsonSessionStoreOptions = {}) {
    this.#dir = resolve(dir);
    this.#warn = options.warn ?? (() => undefined);
    mkdirSync(this.#dir, { recursive: true });
  }

  /** Every readable session on disk, newest first. */
  sessions(): readonly SessionRecord[] {
    const records: SessionRecord[] = [];
    for (const id of this.#ids()) {
      let contents: string;
      try {
        contents = readFileSync(this.#path(id), "utf8");
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) {
          continue;
        }
        throw error;
      }
      const read = this.#parse(id, contents);
      if (read.kind === "session") {
        records.push(read.file.session);
      } else if (read.kind === "unreadable") {
        this.#skipped(id, read.reason);
      }
    }
    return records.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Every session file's id, readable or not, with a stamp that changes
   * whenever the file is written again (each write renames a new file into
   * place), for a reader that reads again only what changed. A file whose
   * stamp cannot be read is still listed, with a `null` stamp: one damaged
   * entry does not hide the rest. Throws only when the directory cannot be
   * listed.
   */
  stamps(): readonly { readonly id: string; readonly stamp: string | null }[] {
    return this.#ids().flatMap((id): { id: string; stamp: string | null }[] => {
      try {
        const { ino, mtimeMs, size } = statSync(this.#path(id));
        return [{ id, stamp: `${ino}:${mtimeMs}:${size}` }];
      } catch (error) {
        return hasErrorCode(error, "ENOENT") ? [] : [{ id, stamp: null }];
      }
    });
  }

  /** Merges `write` into the files it changes, holding the directory's turn. */
  commit(write: SessionStoreWrite): Promise<void> {
    return this.#exclusive(async () => {
      const draft = new Draft(this.#file);
      await draft.commit(write);
      await this.#publish(draft);
    });
  }

  /**
   * Runs `work` holding the directory's turn, taken before `work` starts.
   * Its commits are staged in memory, read back through `view`, and
   * published only once `work` returns; a throw leaves the files as they were.
   */
  transaction<T>(work: (view: SessionStore) => Promise<T>): Promise<T> {
    return this.#exclusive(async () => {
      const draft = new Draft(this.#file);
      const result = await work(draft);
      await this.#publish(draft);
      return result;
    });
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    return (await this.#readable(id))?.session ?? null;
  }

  async getMessage(id: string): Promise<SessionMessage | null> {
    const owner = await this.#ownerOf(id);
    if (owner === undefined) {
      return null;
    }
    const file = await this.#readable(owner);
    return file?.messages.find((message) => message.id === id) ?? null;
  }

  async listMessages(sessionId: string): Promise<SessionMessage[]> {
    return [...((await this.#readable(sessionId))?.messages ?? [])];
  }

  /** The session whose file holds message `id`: the last one seen first, then every file. */
  async #ownerOf(id: string): Promise<string | undefined> {
    const hint = this.#owners.get(id);
    const candidates = [
      ...(hint === undefined ? [] : [hint]),
      ...this.#ids().filter((sessionId) => sessionId !== hint),
    ];
    for (const sessionId of candidates) {
      const read = await this.#read(sessionId);
      if (
        read.kind === "session" &&
        read.file.messages.some((message) => message.id === id)
      ) {
        return sessionId;
      }
    }
    return undefined;
  }

  /** The session's file, which is always directly inside the store's directory. */
  #path(id: string): string {
    if (NOT_A_FILE_NAME.test(id)) {
      throw new Error(
        `[json-session-store] session id ${JSON.stringify(id)} cannot name a file in ${this.#dir}`
      );
    }
    return join(this.#dir, `${id}${SUFFIX}`);
  }

  /** Ids of the session files on disk; a file whose name no id could make is not one. */
  #ids(): string[] {
    return readdirSync(this.#dir)
      .filter((entry) => entry.endsWith(SUFFIX))
      .map((entry) => entry.slice(0, -SUFFIX.length))
      .filter((id) => !NOT_A_FILE_NAME.test(id));
  }

  #skipped(id: string, reason: string): void {
    this.#warn(`[sessions] skipped ${id}${SUFFIX}: ${reason}`);
  }

  /** The session for a read: an unreadable file reads as absent, with a warning. */
  async #readable(id: string): Promise<SessionFile | undefined> {
    const read = await this.#read(id);
    if (read.kind === "unreadable") {
      this.#skipped(id, read.reason);
    }
    return read.kind === "session" ? read.file : undefined;
  }

  async #read(id: string): Promise<Read> {
    let contents: string;
    try {
      contents = await readFile(this.#path(id), "utf8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return { kind: "missing" };
      }
      throw error;
    }
    return this.#parse(id, contents);
  }

  #parse(id: string, contents: string): Read {
    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch {
      return { kind: "unreadable", reason: "not JSON" };
    }
    const parsed = sessionFileSchema.safeParse(value);
    if (!parsed.success) {
      return { kind: "unreadable", reason: "not a session file" };
    }
    if (parsed.data.session.id !== id) {
      return {
        kind: "unreadable",
        reason: `holds session ${parsed.data.session.id}`,
      };
    }
    for (const message of parsed.data.messages) {
      this.#owners.set(message.id, id);
    }
    return { file: parsed.data, kind: "session" };
  }

  /** A session's file as it is on disk now, for a draft over this store. */
  readonly #file: FileSource = {
    find: (id) => this.#ownerOf(id),
    path: (id) => this.#path(id),
    read: async (id) => {
      const read = await this.#read(id);
      if (read.kind === "unreadable") {
        this.#skipped(id, read.reason);
      }
      return read;
    },
  };

  /** Writes every file `draft` changed, one after another, each atomically. */
  async #publish(draft: Draft): Promise<void> {
    for (const [id, file] of draft.changed()) {
      await writeFileAtomic(this.#path(id), file.text);
      for (const message of file.messages) {
        this.#owners.set(message.id, id);
      }
    }
  }

  /** Runs `operation` holding the directory's turn and lock (see the module comment). */
  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const lock = join(this.#dir, LOCK);
    try {
      return await queue.run(this.#dir, () =>
        withFileLock(lock, operation, {
          breakStale: true,
          waitMs: LOCK_WAIT_MS,
        })
      );
    } catch (error) {
      if (!(error instanceof FileLockTimeoutError)) {
        throw error;
      }
      const holder =
        error.holder === undefined ? "" : ` by process ${String(error.holder)}`;
      throw new Error(
        `[json-session-store] sessions in ${this.#dir} are locked${holder}. If no Marbles process is using them, remove ${error.path} (and ${error.path}.break, if present) and retry.`,
        { cause: error }
      );
    }
  }
}

/** How a draft reads a store's files. */
interface FileSource {
  /** The session whose file on disk holds message `id`. */
  readonly find: (id: string) => Promise<string | undefined>;
  readonly path: (id: string) => string;
  readonly read: (id: string) => Promise<Read>;
}

/** A staged file: its record and messages, and the text it will be written as. */
interface StagedFile extends SessionFile {
  readonly text: string;
}

/**
 * The files as one commit or transaction leaves them, staged in memory over
 * what is on disk. Reads see the staged files first. A commit stages every
 * file it changes or none.
 */
class Draft implements SessionStore {
  readonly #files: FileSource;
  readonly #staged = new Map<string, StagedFile>();

  constructor(files: FileSource) {
    this.#files = files;
  }

  async commit(write: SessionStoreWrite): Promise<void> {
    const next = new Map<string, StagedFile>();
    for (const [id, change] of bySession(write)) {
      const file = merge(id, await this.#base(id), change);
      // Encoding now refuses a value that cannot be written before anything is staged.
      const text = JSON.stringify(file, null, 2);
      next.set(id, { ...(JSON.parse(text) as SessionFile), text });
    }
    for (const [id, file] of next) {
      this.#staged.set(id, file);
    }
  }

  async getMessage(id: string): Promise<SessionMessage | null> {
    for (const file of this.#staged.values()) {
      const found = file.messages.find((message) => message.id === id);
      if (found) {
        return structuredClone(found);
      }
    }
    const owner = await this.#files.find(id);
    if (owner === undefined || this.#staged.has(owner)) {
      return null;
    }
    const file = await this.#readable(owner);
    return file?.messages.find((message) => message.id === id) ?? null;
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    return (await this.#readable(id))?.session ?? null;
  }

  async listMessages(sessionId: string): Promise<SessionMessage[]> {
    return [...((await this.#readable(sessionId))?.messages ?? [])];
  }

  /** The staged files, in the order they were first changed. */
  changed(): ReadonlyMap<string, StagedFile> {
    return this.#staged;
  }

  /** A session as this draft holds it: staged, else on disk; unreadable reads as absent. */
  async #readable(id: string): Promise<SessionFile | undefined> {
    const staged = this.#staged.get(id);
    if (staged) {
      return structuredClone({
        messages: staged.messages,
        session: staged.session,
      });
    }
    const read = await this.#files.read(id);
    return read.kind === "session" ? read.file : undefined;
  }

  /** What a commit merges into: the staged file, else the one on disk. */
  async #base(id: string): Promise<SessionFile | undefined> {
    const staged = this.#staged.get(id);
    if (staged) {
      return staged;
    }
    const path = this.#files.path(id);
    const read = await this.#files.read(id);
    if (read.kind === "unreadable") {
      throw new Error(
        `[json-session-store] ${path} is not a readable session (${read.reason}); repair or remove it`
      );
    }
    return read.kind === "session" ? read.file : undefined;
  }
}

/** `write` split into the part each session's file takes, in the order sessions appear. */
function bySession(write: SessionStoreWrite): Map<string, SessionStoreWrite> {
  const changes = new Map<
    string,
    { putMessages: SessionMessage[]; putSessions: SessionRecord[] }
  >();
  const changeOf = (id: string) => {
    const change = changes.get(id) ?? { putMessages: [], putSessions: [] };
    changes.set(id, change);
    return change;
  };
  for (const session of write.putSessions ?? []) {
    changeOf(session.id).putSessions.push(session);
  }
  for (const message of write.putMessages ?? []) {
    changeOf(message.sessionId).putMessages.push(message);
  }
  return changes;
}

/** `file` with `write` merged in by id: a put replaces what it names, and a new message goes last. */
function merge(
  id: string,
  file: SessionFile | undefined,
  write: SessionStoreWrite
): SessionFile {
  const session = write.putSessions?.at(-1) ?? file?.session;
  if (!session) {
    throw new Error(
      `[json-session-store] no session ${id} to file its messages under`
    );
  }
  const messages = [...(file?.messages ?? [])];
  for (const message of write.putMessages ?? []) {
    const index = messages.findIndex((known) => known.id === message.id);
    if (index === -1) {
      messages.push(message);
    } else {
      messages[index] = message;
    }
  }
  return { messages, session };
}
