import { join } from "node:path";

/**
 * The Bun that runs Atlas's workers. The running Bun starts them, so none is
 * needed on the PATH. When this module runs outside Bun (Vitest's Node host,
 * or any Node importer), `execPath` is not a Bun, so it falls back to `bun`
 * from the PATH.
 */
export const WORKER_RUNTIME = process.versions.bun ? process.execPath : "bun";

/**
 * A worker entry beside this module: `src/lib/<name>.ts` from source, and
 * `dist/cli/<name>.js` once built, where every bundle sits side by side.
 */
export function workerEntry(name: string): string {
  return join(
    import.meta.dirname,
    import.meta.filename.endsWith(".ts") ? `${name}.ts` : `${name}.js`
  );
}
