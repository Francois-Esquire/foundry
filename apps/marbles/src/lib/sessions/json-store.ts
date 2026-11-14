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
 * reads the session's file again, so a session another process (the
 * dashboard or `roll`) wrote is seen, and a commit here does not overwrite
 * what it appended: the write is merged by id into the file as read. Each
 * commit is one read-merge-write of one file through a temp-and-rename,
 * which is what makes it atomic, so a write may change one session only.
 * Commits to one file take turns: queued within this process across store
 * instances, and across processes under `<sessionId>.json.lock`, which holds
 * the writer's pid. The store attempts to replace stale locks.
 *
 * A message new to the file stamps the session's `updatedAt` with its
 * `createdAt`, so {@link JsonSessionStore.sessions} lists the most recently
 * appended first.
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

/**
 * Mutations queued per file path. Process-wide on purpose: two stores over
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

  /** Merges `write` into its session's file; a write may change one session only. */
  async commit(write: SessionStoreWrite): Promise<void> {
    const ids = new Set([
      ...(write.putSessions ?? []).map((session) => session.id),
      ...(write.putMessages ?? []).map((message) => message.sessionId),
    ]);
    if (ids.size > 1) {
      throw new Error(
        `[json-session-store] a write changes one session; this one changes ${[...ids].join(", ")}`
      );
    }
    const [id] = ids;
    if (id === undefined) {
      return;
    }
    await this.#change(id, (file) => merge(id, file, write));
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    return (await this.#readable(id))?.session ?? null;
  }

  async getMessage(id: string): Promise<SessionMessage | null> {
    const owner = this.#owners.get(id);
    const candidates = [
      ...(owner === undefined ? [] : [owner]),
      ...this.#ids().filter((sessionId) => sessionId !== owner),
    ];
    for (const sessionId of candidates) {
      const read = await this.#read(sessionId);
      const found =
        read.kind === "session"
          ? read.file.messages.find((message) => message.id === id)
          : undefined;
      if (found) {
        return found;
      }
    }
    return null;
  }

  async listMessages(sessionId: string): Promise<SessionMessage[]> {
    return [...((await this.#readable(sessionId))?.messages ?? [])];
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

  /**
   * Read the session's file afresh, apply `change`, and write the file it
   * returns, taking turns with every other change to that file (see the
   * module comment). Throws, writing nothing, when the file exists but is
   * unreadable.
   */
  #change(
    id: string,
    change: (file: SessionFile | undefined) => SessionFile
  ): Promise<void> {
    const path = this.#path(id);
    return queue.run(path, () =>
      this.#locked(id, path, async () => {
        const read = await this.#read(id);
        if (read.kind === "unreadable") {
          throw new Error(
            `[json-session-store] ${path} is not a readable session (${read.reason}); repair or remove it`
          );
        }
        const file = change(read.kind === "session" ? read.file : undefined);
        await writeFileAtomic(path, JSON.stringify(file, null, 2));
        for (const message of file.messages) {
          this.#owners.set(message.id, id);
        }
      })
    );
  }

  async #locked<T>(
    id: string,
    path: string,
    operation: () => Promise<T>
  ): Promise<T> {
    try {
      return await withFileLock(`${path}.lock`, operation, {
        breakStale: true,
        waitMs: LOCK_WAIT_MS,
      });
    } catch (error) {
      if (!(error instanceof FileLockTimeoutError)) {
        throw error;
      }
      const holder =
        error.holder === undefined ? "" : ` by process ${String(error.holder)}`;
      throw new Error(
        `[json-session-store] session ${id} is locked${holder}. If no Marbles process is using it, remove ${error.path} (and ${error.path}.break, if present) and retry.`,
        { cause: error }
      );
    }
  }
}

/**
 * `file` with `write` merged in by id: a put replaces what it names, and a
 * message new to the file goes last and stamps the session's `updatedAt`.
 */
function merge(
  id: string,
  file: SessionFile | undefined,
  write: SessionStoreWrite
): SessionFile {
  let session = write.putSessions?.at(-1) ?? file?.session;
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
      session = { ...session, updatedAt: message.createdAt };
    } else {
      messages[index] = message;
    }
  }
  return { messages, session };
}
