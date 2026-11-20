import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ScanCacheSeeds {
  around<T>(kind: string, cache: string, scan: () => Promise<T>): Promise<T>;
  dispose(): void;
}

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
