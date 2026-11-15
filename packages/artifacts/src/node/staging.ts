import { readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import {
  hasErrorCode,
  syncDirectory,
  writeFileAtomic,
} from "@foundry/lib/atomic-file";

import type { BlobStagingArea } from "../blob";

/** Inside the blob root, so promotion is a rename on one filesystem. */
const STAGING_DIRECTORY = ".staging";
const STAGED_NAME = /^[a-f0-9-]+$/;
const OWNER_NAME = /^[a-f0-9-]+$/;

/**
 * How long an owner's directory may go unchanged before another owner
 * treats it as abandoned. An owner refreshes it each time it stages a file.
 */
export const STAGING_ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

/** The owners this process runs: never abandoned, however old. */
const liveOwners = new Set<string>();

/**
 * Staging for one `blobFiles` root. Each instance writes under its own
 * `.staging/<uuid>` directory, which `list`, `read` and `remove` never reach.
 *
 * Ownership is judged by age, not by process: processes sharing a root may
 * not share a pid namespace. A directory this process does not own is
 * abandoned once it has gone `STAGING_ABANDONED_AFTER_MS` without changing.
 * So a single chunk that takes longer than that to arrive can have its
 * staging swept by another owner; its promotion then fails and the change
 * rejects, with nothing published and no record written.
 */
export function stagingArea(ready: () => Promise<string>): BlobStagingArea {
  const owner = crypto.randomUUID();
  liveOwners.add(owner);
  /** Swept once, before this instance first stages, so crashes do not wait on `recover`. */
  let swept: Promise<void> | undefined;
  const ownDirectory = async () =>
    join(await ready(), STAGING_DIRECTORY, owner);
  const stagedPath = async (staged: string) => {
    if (!STAGED_NAME.test(staged)) {
      throw new Error("Invalid staged blob name");
    }
    return join(await ownDirectory(), staged);
  };
  async function abandon(): Promise<void> {
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
    const cutoff = Date.now() - STAGING_ABANDONED_AFTER_MS;
    for (const name of owners) {
      if (
        OWNER_NAME.test(name) &&
        !liveOwners.has(name) &&
        (await changedAt(join(root, name))) < cutoff
      ) {
        await rm(join(root, name), { force: true, recursive: true });
      }
    }
  }
  return {
    abandon,
    async discard(staged) {
      await rm(await stagedPath(staged), { force: true });
    },
    async promote(staged) {
      const base = await ready();
      const name = crypto.randomUUID();
      const published = join(base, name);
      await rename(await stagedPath(staged), published);
      try {
        // The rename survives a crash before the records name the file.
        await syncDirectory(base);
      } catch (error) {
        // Not durably published: no record may name it.
        await rm(published, { force: true }).catch(() => undefined);
        throw error;
      }
      return name;
    },
    async stage(bytes) {
      swept ??= abandon().catch((error: unknown) => {
        console.error("Abandoned blob staging cleanup failed", error);
      });
      await swept;
      const staged = crypto.randomUUID();
      const path = await stagedPath(staged);
      try {
        await writeFileAtomic(path, bytes, {
          createDirectory: true,
          fsync: true,
          mode: 0o400,
        });
        // Refreshed as each file is staged, so a live owner never looks abandoned.
        const now = new Date();
        await utimes(await ownDirectory(), now, now);
      } catch (error) {
        // The write may have landed before a later step (the directory sync)
        // failed; nothing tracks this name yet, so it goes here.
        await rm(path, { force: true }).catch(() => undefined);
        throw error;
      }
      return staged;
    },
  };
}

/** When the directory last changed, or now if it is already gone. */
async function changedAt(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return Date.now();
    }
    throw error;
  }
}
