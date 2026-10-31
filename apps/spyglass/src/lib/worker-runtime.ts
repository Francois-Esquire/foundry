import { join } from "node:path";

/**
 * The Bun that runs Spyglass's workers. The running Bun starts them, so none is
 * needed on the PATH. When this module runs outside Bun (Vitest's Node host,
 * or any Node importer), `execPath` is not a Bun, so it falls back to `bun`
 * from the PATH.
 */
export const WORKER_RUNTIME = process.versions.bun ? process.execPath : "bun";

/**
 * The directory Spyglass's child processes (its workers and Git) start in:
 * its own, never the analyzed workspace. Bun reads `bunfig.toml` and `.env`
 * from its working directory, and Windows looks for a bare command such as
 * `bun` or `git` there before the PATH, so a child started in the workspace
 * would take its configuration from the workspace's files. The workspace
 * reaches each child as an argument instead: `--root`, or `git -C`.
 */
export const CHILD_CWD = import.meta.dirname;

/**
 * A worker entry beside this module: `src/lib/<name>.ts` from source, and
 * `dist/lib/<name>.js` once built, where every entry and shared chunk sits
 * side by side, so the lookup holds from whichever chunk this module is in.
 */
export function workerEntry(name: string): string {
  return join(
    import.meta.dirname,
    import.meta.filename.endsWith(".ts") ? `${name}.ts` : `${name}.js`
  );
}
