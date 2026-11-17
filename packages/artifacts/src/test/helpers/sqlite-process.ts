import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
