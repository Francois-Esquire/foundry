import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
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
import { Turns } from "@foundry/lib/turns";
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
 * Every call takes the directory's turn within this process, across store
 * instances, so a call from inside a transaction's work to any store over
 * the directory is refused rather than left waiting for itself. Every
 * commit and transaction also holds `<dir>/.lock` across processes, which
 * holds the writer's pid. The store attempts to replace
 * a stale lock. A transaction stages its commits in memory and writes
 * nothing until `work` returns, so a `work` that throws leaves the files as
 * they were.
 *
 * What a commit or transaction changed is then published file by file, each
 * through a temp-and-rename. A change to one session file is atomic. A
 * change to several is atomic against every reader that takes the
 * directory's turn. A write that fails part way puts back the files already
 * written, but a crash part way through publishing can leave some files
 * written and others not. There is no journal: this store is temporary, and
 * the limit ends when sessions move to the Marbles database.
 *
 * Finding the file that holds a message id (a new message has none) reads
 * again only the files whose stamp changed since this store last read them.
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

/** Why a call from inside a transaction over the directory is refused. */
const REENTRY =
  "JsonSessionStore was called from inside its own transaction; use the view passed to the transaction's work instead";

/**
 * Each directory's turns. Process-wide on purpose: two stores over one
 * directory must still take turns, and the file lock they also take is not
 * reentrant, so it cannot order writers within one process.
 */
const turnsByDirectory = new Map<string, Turns>();

function turnsFor(dir: string): Turns {
  let turns = turnsByDirectory.get(dir);
  if (!turns) {
    turns = new Turns(REENTRY);
    turnsByDirectory.set(dir, turns);
  }
  return turns;
}

type Read =
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly reason: string }
  | { readonly kind: "session"; readonly file: SessionFile };

export class JsonSessionStore implements SessionStore {
  readonly #dir: string;
  readonly #warn: (line: string) => void;
  readonly #turns: Turns;
  /** Message id → its session, as last seen here. A hint: always checked against the file. */
  readonly #owners = new Map<string, string>();
  /** Each file's message ids as last read here, under the stamp the file had then. */
  readonly #indexed = new Map<
    string,
    { readonly ids: ReadonlySet<string>; readonly stamp: string }
  >();

  constructor(dir: string, options: JsonSessionStoreOptions = {}) {
    this.#dir = resolve(dir);
    this.#turns = turnsFor(this.#dir);
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

  getSession(id: string): Promise<SessionRecord | null> {
    return this.#turns.run(
      async () => (await this.#readable(id))?.session ?? null
    );
  }

  getMessage(id: string): Promise<SessionMessage | null> {
    return this.#turns.run(async () => {
      const owner = await this.#ownerOf(id);
      if (owner === undefined) {
        return null;
      }
      const file = await this.#readable(owner);
      return file?.messages.find((message) => message.id === id) ?? null;
    });
  }

  listMessages(sessionId: string): Promise<SessionMessage[]> {
    return this.#turns.run(async () => [
      ...((await this.#readable(sessionId))?.messages ?? []),
    ]);
  }

  /** The session whose file holds message `id`: the last one seen first, then every file. */
  async #ownerOf(id: string): Promise<string | undefined> {
    const hint = this.#owners.get(id);
    const candidates = [
      ...(hint === undefined ? [] : [hint]),
      ...this.#ids().filter((sessionId) => sessionId !== hint),
    ];
    for (const sessionId of candidates) {
      if (await this.#holds(sessionId, id)) {
        return sessionId;
      }
    }
    return undefined;
  }

  /**
   * Whether session `sessionId`'s file holds message `id`. A file whose stamp
   * is the one it had when last read here is answered from what that read
   * found. The stamp is taken before the read, so a write landing between
   * the two leaves a stamp that no longer matches, and the next call reads
   * the file again.
   */
  async #holds(sessionId: string, id: string): Promise<boolean> {
    let stamp: string;
    try {
      const { ino, mtimeMs, size } = await stat(this.#path(sessionId));
      stamp = `${ino}:${mtimeMs}:${size}`;
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        this.#indexed.delete(sessionId);
        return false;
      }
      throw error;
    }
    const known = this.#indexed.get(sessionId);
    if (known?.stamp === stamp) {
      return known.ids.has(id);
    }
    const read = await this.#read(sessionId);
    const ids = new Set(
      read.kind === "session"
        ? read.file.messages.map((message) => message.id)
        : []
    );
    this.#indexed.set(sessionId, { ids, stamp });
    return ids.has(id);
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

  /**
   * The session's file as it reads now. A file that cannot be read at all
   * (no permission, a directory in its place) throws, naming the file: a
   * file that may hold any message is never passed over.
   */
  async #read(id: string): Promise<Read> {
    const path = this.#path(id);
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return { kind: "missing" };
      }
      throw new Error(
        `[json-session-store] cannot read ${path}: ${error instanceof Error ? error.message : String(error)}; repair or remove it`,
        { cause: error }
      );
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

  /**
   * Writes every file `draft` changed, one after another, each atomically.
   * When a write fails, the files already written get back what they held
   * (or are removed, if they were new), so the change lands whole or not at
   * all; the failure is rethrown.
   */
  async #publish(draft: Draft): Promise<void> {
    const written: { readonly id: string; readonly prior?: string }[] = [];
    try {
      for (const [id, file] of draft.changed()) {
        const prior = await this.#text(id);
        await writeFileAtomic(this.#path(id), file.text);
        written.push(prior === undefined ? { id } : { id, prior });
      }
    } catch (error) {
      await this.#restore(written, error);
      throw error;
    }
    for (const [id, file] of draft.changed()) {
      for (const message of file.messages) {
        this.#owners.set(message.id, id);
      }
    }
  }

  /** A session file's text as it is on disk, `undefined` when there is none. */
  async #text(id: string): Promise<string | undefined> {
    try {
      return await readFile(this.#path(id), "utf8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    }
  }

  /** Puts back what `written` replaced, newest first, after `cause` stopped a publish. */
  async #restore(
    written: readonly { readonly id: string; readonly prior?: string }[],
    cause: unknown
  ): Promise<void> {
    const failures: unknown[] = [];
    for (const { id, prior } of [...written].reverse()) {
      try {
        await (prior === undefined
          ? rm(this.#path(id), { force: true })
          : writeFileAtomic(this.#path(id), prior));
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        [cause, ...failures],
        `[json-session-store] a write in ${this.#dir} failed and the files already written could not all be put back; the sessions may hold part of the change`
      );
    }
  }

  /** Runs `operation` holding the directory's turn and lock (see the module comment). */
  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const lock = join(this.#dir, LOCK);
    try {
      return await this.#turns.run(() =>
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
 * file it changes or none. Its calls take turns, so overlapping commits
 * through one view build on each other, and one refused leaves the next
 * free to run.
 */
class Draft implements SessionStore {
  readonly #files: FileSource;
  readonly #staged = new Map<string, StagedFile>();
  readonly #turns = new Turns(
    "A JsonSessionStore transaction view was called from inside one of its own calls"
  );

  constructor(files: FileSource) {
    this.#files = files;
  }

  commit(write: SessionStoreWrite): Promise<void> {
    return this.#turns.run(async () => {
      const next = new Map<string, SessionFile | undefined>();
      const fileOf = async (id: string) => {
        if (!next.has(id)) {
          next.set(id, await this.#base(id));
        }
        return next.get(id);
      };
      for (const session of write.putSessions ?? []) {
        const file = await fileOf(session.id);
        next.set(session.id, { messages: file?.messages ?? [], session });
      }
      for (const message of write.putMessages ?? []) {
        const owner = await this.#ownerOf(message.id, next);
        if (owner !== undefined && owner !== message.sessionId) {
          const former = await fileOf(owner);
          if (former) {
            next.set(owner, withoutMessage(former, message.id));
          }
        }
        const file = await fileOf(message.sessionId);
        if (!file) {
          throw new Error(
            `[json-session-store] no session ${message.sessionId} to file its messages under`
          );
        }
        next.set(message.sessionId, withMessage(file, message));
      }
      // Encoding every file first refuses a value that cannot be written before anything is staged.
      const staged = [...next].flatMap(([id, file]): [string, StagedFile][] =>
        file ? [[id, encoded(file)]] : []
      );
      for (const [id, file] of staged) {
        this.#staged.set(id, file);
      }
    });
  }

  getMessage(id: string): Promise<SessionMessage | null> {
    return this.#turns.run(async () => {
      const owner = await this.#ownerOf(id, new Map());
      const file =
        owner === undefined ? undefined : await this.#readable(owner);
      return file?.messages.find((message) => message.id === id) ?? null;
    });
  }

  getSession(id: string): Promise<SessionRecord | null> {
    return this.#turns.run(
      async () => (await this.#readable(id))?.session ?? null
    );
  }

  listMessages(sessionId: string): Promise<SessionMessage[]> {
    return this.#turns.run(async () => [
      ...((await this.#readable(sessionId))?.messages ?? []),
    ]);
  }

  /** The staged files, in the order they were first changed. */
  changed(): ReadonlyMap<string, StagedFile> {
    return this.#staged;
  }

  /**
   * The session whose file holds message `id`, as this draft sees it:
   * `next` (a commit in progress) first, then the staged files, then the
   * files on disk that neither holds.
   */
  async #ownerOf(
    id: string,
    next: ReadonlyMap<string, SessionFile | undefined>
  ): Promise<string | undefined> {
    const holds = (file: SessionFile | undefined) =>
      file?.messages.some((message) => message.id === id) === true;
    for (const [sessionId, file] of next) {
      if (holds(file)) {
        return sessionId;
      }
    }
    for (const [sessionId, file] of this.#staged) {
      if (!next.has(sessionId) && holds(file)) {
        return sessionId;
      }
    }
    const onDisk = await this.#files.find(id);
    return onDisk === undefined || next.has(onDisk) || this.#staged.has(onDisk)
      ? undefined
      : onDisk;
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

  /** What a commit builds on: the staged file, else the one on disk. */
  async #base(id: string): Promise<SessionFile | undefined> {
    const staged = this.#staged.get(id);
    if (staged) {
      return { messages: staged.messages, session: staged.session };
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

/** `file` holding `message`: a known id keeps its place, a new one goes last. */
function withMessage(file: SessionFile, message: SessionMessage): SessionFile {
  const index = file.messages.findIndex((known) => known.id === message.id);
  return {
    messages:
      index === -1
        ? [...file.messages, message]
        : file.messages.map((known, at) => (at === index ? message : known)),
    session: file.session,
  };
}

/** `file` without message `id`. */
function withoutMessage(file: SessionFile, id: string): SessionFile {
  return {
    messages: file.messages.filter((message) => message.id !== id),
    session: file.session,
  };
}

/** `file` as staged: detached, with the text it will be written as. */
function encoded(file: SessionFile): StagedFile {
  const text = JSON.stringify(file, null, 2);
  return { ...(JSON.parse(text) as SessionFile), text };
}
