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
 * SQLite's locks are per file, not per client. The wrapped client must have
 * one connection (`concurrency: 1`), so the pragmas set when it opens hold
 * for everything that runs on it.
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
  const queue = queueFor(file);
  const turn = () => queue.next(wait, file);
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
    close: () => client.close(),
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
  /** Resolves with the function that gives the turn back; call it once. */
  next(wait: number, file: string): Promise<() => void>;
}

const queues = new Map<string, Queue>();

function queueFor(file: string): Queue {
  let queue = queues.get(file);
  if (queue === undefined) {
    queue = fifo();
    queues.set(file, queue);
  }
  return queue;
}

function fifo(): Queue {
  let tail: Promise<void> = Promise.resolve();
  return {
    next(wait, file) {
      const { promise: held, resolve: done } = Promise.withResolvers<void>();
      const ready = tail;
      tail = ready.then(() => held);
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          done();
        }
      };
      return new Promise((resolve, reject) => {
        let refused = false;
        const timer = setTimeout(() => {
          refused = true;
          reject(
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
            resolve(release);
          }
        });
      });
    },
  };
}
