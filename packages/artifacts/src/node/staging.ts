import { readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import {
  hasErrorCode,
  syncDirectory,
  writeFileAtomic,
} from "@foundry/lib/node/atomic-file";

import type { BlobStagingArea } from "../blob-staging";

const STAGING_DIRECTORY = ".staging";
const STAGED_NAME = /^[a-f0-9-]+$/;
const OWNER_NAME = /^[a-f0-9-]+$/;

export const STAGING_ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

const liveOwners = new Set<string>();

export function stagingArea(ready: () => Promise<string>): BlobStagingArea {
  const owner = crypto.randomUUID();
  liveOwners.add(owner);
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
        await syncDirectory(base);
      } catch (error) {
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
        const now = new Date();
        await utimes(await ownDirectory(), now, now);
      } catch (error) {
        await rm(path, { force: true }).catch(() => undefined);
        throw error;
      }
      return staged;
    },
  };
}

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
