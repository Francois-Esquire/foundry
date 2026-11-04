import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ScanCacheSeeds {
  /**
   * Runs `scan` with `cache` seeded from the first scan of the same `kind`,
   * or, for the first of a kind, keeps the cache that scan left as its seed.
   */
  around<T>(kind: string, cache: string, scan: () => Promise<T>): Promise<T>;
  /** Removes every kept seed. */
  dispose(): void;
}

/**
 * Scan caches kept from the first scan of each kind of fixture copy, to seed
 * later copies before they scan. The semantics cache is keyed by package and
 * content fingerprint, not by the workspace's path, so a seeded scan of the
 * same sources publishes what a cold scan would, without a TypeScript worker
 * per package. A test that asserts what a cold scan does must not seed.
 */
export function scanCacheSeeds(): ScanCacheSeeds {
  const directory = mkdtempSync(join(tmpdir(), "spyglass-cache-seeds-"));
  const seeds = new Map<string, string>();
  return {
    async around(kind, cache, scan) {
      const seed = seeds.get(kind);
      if (seed !== undefined) {
        cpSync(seed, cache, { recursive: true });
      }
      const result = await scan();
      if (seed === undefined && existsSync(cache)) {
        const kept = join(directory, String(seeds.size));
        cpSync(cache, kept, { recursive: true });
        seeds.set(kind, kept);
      }
      return result;
    },
    dispose() {
      rmSync(directory, { force: true, recursive: true });
    },
  };
}
