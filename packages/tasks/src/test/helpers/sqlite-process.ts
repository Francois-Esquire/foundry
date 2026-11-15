import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A child script that runs statements, one at a time, on a SQLite file with
 * the runtime's own
 * SQLite (`bun:sqlite` on Bun, `node:sqlite` on Node) and no busy timeout,
 * printing `committed` or the error.
 */
const SCRIPT = `const [path, statements] = process.argv.slice(2);
const open = typeof Bun === "undefined"
  ? async () => new (await import("node:sqlite")).DatabaseSync(path, { timeout: 0 })
  : async () => new (await import("bun:sqlite")).Database(path);
const database = await open();
try {
  for (const statement of JSON.parse(statements)) {
    database.exec(statement);
  }
  console.log("committed");
} catch (error) {
  console.log(String(error));
} finally {
  database.close();
}
`;

/**
 * Runs `statements` in order on the SQLite file at `path` from another
 * process, and waits
 * for it synchronously, so it can act between two statements of an async
 * client in this process (from a Drizzle logger hook, which runs just before
 * a statement does). It must be another process: SQLite's file locks are
 * per process, so a second SQLite library in this one would not see this
 * process's locks. Returns `committed` or the error SQLite gave.
 */
export function execInAnotherProcess(
  path: string,
  statements: readonly string[]
): string {
  const directory = mkdtempSync(join(tmpdir(), "foundry-sqlite-process-"));
  try {
    const script = join(directory, "exec.mjs");
    writeFileSync(script, SCRIPT);
    return execFileSync(
      process.execPath,
      [script, path, JSON.stringify(statements)],
      {
        encoding: "utf8",
        timeout: 30_000,
      }
    ).trim();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}
