import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { hasErrorCode, writeFileAtomic } from "../../atomic-file";
import { acquireFileLock, FileLockTimeoutError } from "../../file-lock";
import { KeyedQueue } from "../../keyed-queue";
import type { AuthorizationSubject } from "./address";
import type {
  DocumentGrantRepositoryOptions,
  GrantDocumentStorage,
} from "./document";
import { DocumentGrantRepository } from "./document";

const DEFAULT_LOCK_WAIT_MS = 5000;
const PRIVATE_FILE = 0o600;
const PRIVATE_DIRECTORY = 0o700;

export interface FileGrantRepositoryOptions<S extends AuthorizationSubject, C>
  extends Omit<DocumentGrantRepositoryOptions<S, C>, "storage"> {
  /** How long to wait for another writer's lock before refusing. Defaults to 5s. */
  readonly lockWaitMs?: number;
  /** Where the Grants live. Its directory is created private on first use. */
  readonly path: string;
}

/** Transactions queued per resolved path, across every repository instance in this process. */
const transactions = new KeyedQueue();

/**
 * The writer lock. A lock left by a crashed writer is never broken: the
 * writer may have died mid-transaction, so a person decides.
 */
async function acquireLock(
  path: string,
  waitMs: number
): Promise<() => Promise<void>> {
  const lock = `${path}.lock`;
  try {
    return await acquireFileLock(lock, { mode: PRIVATE_FILE, waitMs });
  } catch (error) {
    if (!(error instanceof FileLockTimeoutError)) {
      throw error;
    }
    throw new Error(
      `Grants are locked at ${lock}; refusing authorization. If no process is using this store, remove the abandoned lock and retry.`,
      { cause: error }
    );
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
}

function fileStorage(path: string, lockWaitMs: number): GrantDocumentStorage {
  return {
    transact: (apply) =>
      transactions.run(path, async () => {
        await mkdir(dirname(path), {
          mode: PRIVATE_DIRECTORY,
          recursive: true,
        });
        const unlock = await acquireLock(path, lockWaitMs);
        try {
          const { next, result } = apply(await readText(path));
          if (next !== undefined) {
            await writeFileAtomic(path, next, {
              fsync: true,
              mode: PRIVATE_FILE,
            });
          }
          return result;
        } finally {
          await unlock();
        }
      }),
  };
}

/** One file of Grants. See the module comment for its guarantees. */
export class FileGrantRepository<
  S extends AuthorizationSubject,
  C,
> extends DocumentGrantRepository<S, C> {
  constructor(options: FileGrantRepositoryOptions<S, C>) {
    const { lockWaitMs, path, ...document } = options;
    super({
      ...document,
      storage: fileStorage(resolve(path), lockWaitMs ?? DEFAULT_LOCK_WAIT_MS),
    });
  }
}
