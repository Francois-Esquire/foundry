import { readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  hasErrorCode,
  syncDirectorySync,
  writeFileAtomic,
} from "@foundry/lib/atomic-file";
import { processAlive } from "@foundry/lib/file-lock";

import type { BlobStagingArea } from "../blob";

/** Inside the blob root, so promotion is a rename on one filesystem. */
const STAGING_DIRECTORY = ".staging";
const STAGED_NAME = /^[a-f0-9-]+$/;
const OWNER_NAME = /^(\d+)-[a-f0-9-]+$/;

/** The owners this process runs, so a restart that reuses the pid still abandons the old one's. */
const liveOwners = new Set<string>();

/**
 * Staging for one `blobFiles` root. Each instance writes under its own
 * `.staging/<pid>-<uuid>` directory, which `list`, `read` and `remove` never
 * reach. A directory is abandoned once its owner is gone: its process has
 * exited, or it carries this process's pid but no owner this process runs
 * (a restart that reused the pid, as pid 1 in a container does).
 */
export function stagingArea(ready: () => Promise<string>): BlobStagingArea {
  const owner = `${String(process.pid)}-${crypto.randomUUID()}`;
  liveOwners.add(owner);
  const ownDirectory = async () =>
    join(await ready(), STAGING_DIRECTORY, owner);
  const stagedPath = async (staged: string) => {
    if (!STAGED_NAME.test(staged)) {
      throw new Error("Invalid staged blob name");
    }
    return join(await ownDirectory(), staged);
  };
  return {
    async abandon() {
      const root = join(await ready(), STAGING_DIRECTORY);
      let owners: string[];
      try {
        owners = await readdir(root);
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) {
          return;
        }
        throw error;
      }
      for (const name of owners) {
        if (isAbandoned(name)) {
          await rm(join(root, name), { force: true, recursive: true });
        }
      }
    },
    async discard(staged) {
      await rm(await stagedPath(staged), { force: true });
    },
    async promote(staged) {
      const base = await ready();
      const published = crypto.randomUUID();
      await rename(await stagedPath(staged), join(base, published));
      // The rename survives a crash before the records name the file.
      syncDirectorySync(base);
      return published;
    },
    async stage(bytes) {
      const staged = crypto.randomUUID();
      await writeFileAtomic(await stagedPath(staged), bytes, {
        createDirectory: true,
        fsync: true,
        mode: 0o400,
      });
      return staged;
    },
  };
}

function isAbandoned(name: string): boolean {
  const match = OWNER_NAME.exec(name);
  if (!match) {
    // Not one this package wrote: left for a person to look at.
    return false;
  }
  const pid = Number(match[1]);
  return pid === process.pid ? !liveOwners.has(name) : !processAlive(pid);
}
