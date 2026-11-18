import { statSync } from "node:fs";

import type {
  Client,
  InArgs,
  InStatement,
  ResultSet,
  Transaction,
  TransactionMode,
} from "@libsql/client";

export class DatabaseBusyError extends Error {
  override readonly name = "DatabaseBusyError";
}

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

export interface SerialClientOptions {
  readonly connect?: () => Client;
  readonly settings?: readonly string[];
}

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
  let unset = settings.length > 0;
  let closed = false;
  const turn = () => queue.next(wait);
  async function prepared(): Promise<Client> {
    if (unset) {
      for (const setting of settings) {
        await current.execute(setting);
      }
      unset = false;
    }
    return current;
  }
  async function recover(error: unknown): Promise<void> {
    if (options.connect === undefined || closed || !nativeBusy(error)) {
      return;
    }
    const failed = current;
    current = options.connect();
    unset = settings.length > 0;
    closeFailed(failed);
    collect();
    await prepared().catch(() => undefined);
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

function closeFailed(client: Client): void {
  try {
    client.close();
  } catch {
    // biome-ignore lint/complexity/noUselessReturn: End the best-effort operation on failure.
    return;
  }
}

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

function nativeBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_BUSY")
  );
}

export function fileIdentity(file: string): string {
  const { dev, ino } = statSync(file);
  return `${String(dev)}:${String(ino)}`;
}

export function queuedFiles(): readonly string[] {
  return [...queues.keys()];
}

function heldUntilSettled(
  transaction: Transaction,
  release: () => void,
  recover: (error: unknown) => Promise<void>
): Transaction {
  let failure: unknown;
  let settled = false;
  const watched = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      failure ??= nativeBusy(error) ? error : undefined;
      throw error;
    }
  };
  const abandon = async (): Promise<void> => {
    try {
      await transaction.rollback();
    } catch {
      return undefined;
    }
  };
  const settle = async (
    end: () => Promise<void>,
    committing = false
  ): Promise<void> => {
    if (settled) {
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
  leave(): void;
  next(wait: number): Promise<() => void>;
}

const queues = new Map<string, Queue & { join(): void }>();

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
        ready.then(() => {
          clearTimeout(timer);
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
