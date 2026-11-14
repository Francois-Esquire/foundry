import { statSync } from "node:fs";

import type {
  Client,
  InArgs,
  InStatement,
  ResultSet,
  Transaction,
  TransactionMode,
} from "@libsql/client";

/**
 * The database stayed busy past the wait: in this process, its turn was not
 * given in time (`serialClient`); from another, SQLite's busy timeout ran
 * out (`SQLITE_BUSY`, which `busyError` turns into this).
 */
export class DatabaseBusyError extends Error {
  override readonly name = "DatabaseBusyError";
}

/**
 * `error` as a `DatabaseBusyError` when it, or anything in its causes, is
 * SQLite refusing a lock after its busy timeout; undefined otherwise.
 */
export function busyError(error: unknown): DatabaseBusyError | undefined {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (cause instanceof DatabaseBusyError) {
      return cause;
    }
    if (
      "code" in cause &&
      typeof cause.code === "string" &&
      cause.code.startsWith("SQLITE_BUSY")
    ) {
      return new DatabaseBusyError(
        "the Marbles database is busy: another process held its write lock longer than the busy timeout; retry",
        { cause: error }
      );
    }
  }
}

/** How a `serialClient` opens, and opens again, its libSQL client. */
export interface SerialClientOptions {
  /**
   * Opens a fresh client on the same file with the same configuration.
   * With it, a client SQLite has answered `SQLITE_BUSY` is replaced; see
   * `serialClient`.
   */
  readonly connect?: () => Client;
  /**
   * The connection settings (`PRAGMA`s) every client runs before anything
   * else: the first before its first operation, and each replacement
   * before the handle runs anything on it.
   */
  readonly settings?: readonly string[];
}

/**
 * A libSQL client whose operations take turns. The native driver is
 * synchronous: a connection that waits for the write lock blocks the whole
 * thread in SQLite's busy handler, so a second transaction in the same
 * process would stall the first one it waits for until the busy timeout and
 * then fail with `SQLITE_BUSY`. Here every operation, and every transaction
 * for its whole life, holds a turn on the file's queue instead, and waits
 * for it without blocking. Other processes still meet the busy timeout.
 *
 * One queue serves every client this process opens on the same file, since
 * SQLite's locks are per file, not per client or per path: the queue is
 * keyed by the file's identity (`fileIdentity`), taken once `client` has
 * opened, and so created, the file at `file`. A link to the database, or
 * another spelling of its name on a case-insensitive filesystem, shares
 * its queue. When the identity cannot be had, `client` is closed and the
 * error thrown. The queue is dropped once its last client has closed and no
 * turn is pending. The wrapped client must have one connection
 * (`concurrency: 1`), so the pragmas set when it opens hold for everything
 * that runs on it.
 *
 * A turn that is not given within `wait` ms is refused, as SQLite refuses a
 * lock after its busy timeout. That is also how code that uses the database
 * from inside one of its own transactions, and so waits for itself, fails.
 *
 * A connection SQLite answers `SQLITE_BUSY` (another process held the lock
 * past the busy timeout), whether an operation, a transaction's `BEGIN`,
 * one of its statements, or its `COMMIT` or `ROLLBACK`, is not used again:
 * `@libsql/client` 0.18 leaves the failed statement open on it, so its next
 * transaction fails at `COMMIT` ("SQL statements in progress"), and so
 * would every later write on a handle kept open for hours. Given
 * `options.connect`, the client is replaced before the turn is given back,
 * so nothing runs on the failed one: a fresh client is opened, `settings`
 * are applied to it, and the failed one is closed and its statements
 * collected (`collect`). A refused `COMMIT` is rolled back on the failed
 * client first, which releases its locks. The error still reaches the
 * caller, and nothing is run again for it.
 *
 * Closing the failed client cannot release a lock another handle in this
 * process holds on the file. It is closed inside the turn, and every
 * client this process has on the file takes its turns on this same queue,
 * so no other one is inside an operation or a transaction then. And
 * SQLite itself keeps a descriptor open while another connection in the
 * process holds a lock on the same file (it closes it once those locks
 * go), and shares one `-shm` mapping per file among connections, so the
 * POSIX rule that closing any descriptor drops the process's locks does
 * not reach through it.
 */
export function serialClient(
  client: Client,
  file: string,
  wait: number,
  options: SerialClientOptions = {}
): Client {
  let identity: string;
  try {
    identity = fileIdentity(file);
  } catch (error) {
    client.close();
    throw error;
  }
  const queue = queueFor(identity, file);
  const settings = options.settings ?? [];
  let current = client;
  /** Whether `current` still needs `settings`. */
  let unset = settings.length > 0;
  let closed = false;
  const turn = () => queue.next(wait);
  /** Inside a turn: apply `settings` to a client that has not had them. */
  async function prepared(): Promise<Client> {
    if (unset) {
      for (const setting of settings) {
        await current.execute(setting);
      }
      unset = false;
    }
    return current;
  }
  /** Inside a turn: replace the client if SQLite answered `error` with busy. */
  async function recover(error: unknown): Promise<void> {
    if (options.connect === undefined || closed || !nativeBusy(error)) {
      return;
    }
    const failed = current;
    current = options.connect();
    unset = settings.length > 0;
    try {
      failed.close();
    } catch {
      // It is given up either way; the caller hears the original error.
    }
    collect();
    try {
      await prepared();
    } catch {
      // Left unset: the next turn applies them before anything else.
    }
  }
  async function inTurn<T>(work: (client: Client) => Promise<T>): Promise<T> {
    const release = await turn();
    try {
      return await work(await prepared());
    } catch (error) {
      await recover(error);
      throw error;
    } finally {
      release();
    }
  }
  return {
    batch: (stmts: Array<InStatement | [string, InArgs?]>, mode) =>
      inTurn((live) => live.batch(stmts, mode)),
    close() {
      try {
        current.close();
      } finally {
        if (!closed) {
          closed = true;
          queue.leave();
        }
      }
    },
    get closed() {
      return current.closed;
    },
    execute: ((stmtOrSql: InStatement | string, args?: InArgs) =>
      inTurn((live) =>
        typeof stmtOrSql === "string"
          ? live.execute(stmtOrSql, args)
          : live.execute(stmtOrSql)
      )) as Client["execute"],
    executeMultiple: (sql: string) =>
      inTurn((live) => live.executeMultiple(sql)),
    migrate: (stmts: InStatement[]) => inTurn((live) => live.migrate(stmts)),
    get protocol() {
      return current.protocol;
    },
    reconnect: () => current.reconnect(),
    sync: () => inTurn((live) => live.sync()),
    async transaction(mode?: TransactionMode): Promise<Transaction> {
      const release = await turn();
      try {
        const live = await prepared();
        return heldUntilSettled(await live.transaction(mode), release, recover);
      } catch (error) {
        try {
          await recover(error);
        } finally {
          release();
        }
        throw error;
      }
    },
  };
}

/**
 * Collect what is unreachable now. The native driver keeps the statement
 * SQLite refused open, and a connection whose statement is open does not
 * close until that statement is collected: it keeps holding a read lock
 * that would stop the replacement, in this same process, from committing.
 * Nothing else releases it, so the failed client's statements are
 * collected at once, under Bun (`Bun.gc`), or under Node started with
 * `--expose-gc`.
 */
function collect(): void {
  const runtime = globalThis as {
    readonly Bun?: { gc(force: boolean): void };
    readonly gc?: () => void;
  };
  if (runtime.Bun === undefined) {
    runtime.gc?.();
  } else {
    runtime.Bun.gc(true);
  }
}

/** Whether `error` is SQLite refusing a lock, as the native driver reports it. */
function nativeBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_BUSY")
  );
}

/**
 * Which file `file` is, whatever path names it: its device and inode, read
 * with `stat`, which follows links and never opens the file. Opening and
 * closing a descriptor to a SQLite database, even only to resolve its
 * path (`realpath` does on macOS), drops every POSIX lock this process
 * holds on it, including those of the connections still open.
 */
export function fileIdentity(file: string): string {
  const { dev, ino } = statSync(file);
  return `${String(dev)}:${String(ino)}`;
}

/** The identities of the files this process has a queue for: some client is open, or a turn is pending. */
export function queuedFiles(): readonly string[] {
  return [...queues.keys()];
}

/**
 * The transaction, giving its turn back once it commits, rolls back, or
 * closes. When SQLite answered one of its statements, or its end, with
 * busy, `recover` replaces the client first, still inside the turn.
 */
function heldUntilSettled(
  transaction: Transaction,
  release: () => void,
  recover: (error: unknown) => Promise<void>
): Transaction {
  let failure: unknown;
  /** Whether the turn was given back: a later end runs outside it. */
  let settled = false;
  const watched = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      failure ??= nativeBusy(error) ? error : undefined;
      throw error;
    }
  };
  /**
   * A `COMMIT` SQLite refused leaves the transaction open, and with it the
   * locks it took, on a connection that would not let go of them when
   * closed while the failed statement is still open. Rolling it back first
   * releases them, and leaves the change certainly not landed.
   */
  const abandon = async (): Promise<void> => {
    try {
      await transaction.rollback();
    } catch {
      // Closing the client discards what is left.
    }
  };
  const settle = async (
    end: () => Promise<void>,
    committing = false
  ): Promise<void> => {
    if (settled) {
      // A rollback after a `COMMIT` that failed (as Drizzle sends one): with
      // the client replaced, closing it already discarded the transaction.
      if (failure === undefined) {
        await end();
      }
      return;
    }
    try {
      await watched(end);
    } finally {
      settled = true;
      try {
        if (committing && failure !== undefined) {
          await abandon();
        }
        await recover(failure);
      } finally {
        release();
      }
    }
  };
  return {
    batch: (stmts: InStatement[]): Promise<ResultSet[]> =>
      watched(() => transaction.batch(stmts)),
    close() {
      try {
        transaction.close();
      } finally {
        // Closing gives the turn back at once, or once the client is replaced.
        if (!settled) {
          settled = true;
          if (failure === undefined) {
            release();
          } else {
            recover(failure).finally(release);
          }
        }
      }
    },
    get closed() {
      return transaction.closed;
    },
    commit: () => settle(() => transaction.commit(), true),
    execute: (stmt: InStatement) => watched(() => transaction.execute(stmt)),
    executeMultiple: (sql: string) =>
      watched(() => transaction.executeMultiple(sql)),
    rollback: () => settle(() => transaction.rollback()),
  };
}

interface Queue {
  /** One more client closed: the queue goes once none is open and no turn is pending. */
  leave(): void;
  /** Resolves with the function that gives the turn back; call it once. */
  next(wait: number): Promise<() => void>;
}

const queues = new Map<string, Queue & { join(): void }>();

/** The queue for the file `identity` names, joined by one more client. */
function queueFor(identity: string, file: string): Queue {
  let queue = queues.get(identity);
  if (queue === undefined) {
    const created = fifo(file, () => {
      if (queues.get(identity) === created) {
        queues.delete(identity);
      }
    });
    queue = created;
    queues.set(identity, queue);
  }
  queue.join();
  return queue;
}

function fifo(file: string, idle: () => void): Queue & { join(): void } {
  let tail: Promise<void> = Promise.resolve();
  let clients = 0;
  let pending = 0;
  const settle = () => {
    if (clients === 0 && pending === 0) {
      idle();
    }
  };
  return {
    join() {
      clients += 1;
    },
    leave() {
      clients -= 1;
      settle();
    },
    next(wait) {
      pending += 1;
      const { promise: held, resolve: done } = Promise.withResolvers<void>();
      const ready = tail;
      tail = ready.then(() => held);
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          pending -= 1;
          done();
          settle();
        }
      };
      return new Promise((give, refuse) => {
        let refused = false;
        const timer = setTimeout(() => {
          refused = true;
          refuse(
            new DatabaseBusyError(
              `the Marbles database at ${file} stayed busy for ${String(wait)} ms in this process; a transaction may be waiting on itself`
            )
          );
        }, wait);
        // Every turn ahead resolves once given back; none rejects.
        ready.then(() => {
          clearTimeout(timer);
          // A refused waiter passes its turn straight on.
          if (refused) {
            release();
          } else {
            give(release);
          }
        });
      });
    },
  };
}
