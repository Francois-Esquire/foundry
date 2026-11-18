import { join } from "node:path";

export const WORKER_RUNTIME = process.versions.bun ? process.execPath : "bun";

export const CHILD_CWD = import.meta.dirname;

export function workerEntry(name: string): string {
  return join(
    import.meta.dirname,
    import.meta.filename.endsWith(".ts") ? `${name}.ts` : `${name}.js`
  );
}
