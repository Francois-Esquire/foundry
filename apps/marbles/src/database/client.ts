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
 */
export function serialClient(
  client: Client,
  file: string,
  wait: number
): Client {
  let identity: string;
  try {
    identity = fileIdentity(file);
  } catch (error) {
    client.close();
    throw error;
  }
  const queue = queueFor(identity, file);
  let closed = false;
  const turn = () => queue.next(wait);
  async function inTurn<T>(work: () => Promise<T>): Promise<T> {
    const release = await turn();
    try {
      return await work();
    } finally {
      release();
    }
  }
  return {
    batch: (stmts: Array<InStatement | [string, InArgs?]>, mode) =>
      inTurn(() => client.batch(stmts, mode)),
    close() {
      try {
        client.close();
      } finally {
        if (!closed) {
          closed = true;
          queue.leave();
        }
      }
    },
    get closed() {
      return client.closed;
    },
    execute: ((stmtOrSql: InStatement | string, args?: InArgs) =>
      inTurn(() =>
        typeof stmtOrSql === "string"
          ? client.execute(stmtOrSql, args)
          : client.execute(stmtOrSql)
      )) as Client["execute"],
    executeMultiple: (sql: string) => inTurn(() => client.executeMultiple(sql)),
    migrate: (stmts: InStatement[]) => inTurn(() => client.migrate(stmts)),
    get protocol() {
      return client.protocol;
    },
    reconnect: () => client.reconnect(),
    sync: () => inTurn(() => client.sync()),
    async transaction(mode?: TransactionMode): Promise<Transaction> {
      const release = await turn();
      try {
        return heldUntilSettled(await client.transaction(mode), release);
      } catch (error) {
        release();
        throw error;
      }
    },
  };
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

/** The transaction, giving its turn back once it commits, rolls back, or closes. */
function heldUntilSettled(
  transaction: Transaction,
  release: () => void
): Transaction {
  const settle = async <T>(end: () => Promise<T>): Promise<T> => {
    try {
      return await end();
    } finally {
      release();
    }
  };
  return {
    batch: (stmts: InStatement[]): Promise<ResultSet[]> =>
      transaction.batch(stmts),
    close() {
      try {
        transaction.close();
      } finally {
        release();
      }
    },
    get closed() {
      return transaction.closed;
    },
    commit: () => settle(() => transaction.commit()),
    execute: (stmt: InStatement) => transaction.execute(stmt),
    executeMultiple: (sql: string) => transaction.executeMultiple(sql),
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
            new Error(
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
