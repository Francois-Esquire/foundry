import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CLIENT = resolve("../../node_modules/@libsql/client/lib-esm/node.js");

/** Another process holding a database's write lock until released. */
export interface WriteLockHolder {
  /** Let go of the lock and wait for the process to exit. */
  release(): Promise<void>;
}

/**
 * Take the write lock on the SQLite file `file` in another process and
 * hold it, so a writer here waits for its busy timeout and is refused.
 * `children` collects the process, for a test to kill should it fail first.
 */
export async function holdWriteLock(
  file: string,
  children: ChildProcess[]
): Promise<WriteLockHolder> {
  const release = `${file}.release-write`;
  const script = `import { createClient } from ${JSON.stringify(CLIENT)};
import { existsSync } from "node:fs";
const client = createClient({ url: ${JSON.stringify(pathToFileURL(file).href)} });
const held = await client.transaction("write");
await held.execute("SELECT 1");
process.stdout.write("held\\n");
while (!existsSync(${JSON.stringify(release)})) await new Promise((done) => setTimeout(done, 5));
await held.rollback();
client.close();
`;
  const child = spawn("bun", ["-e", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  await new Promise<void>((ready, failed) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("held")) {
        ready();
      }
    });
    child.once("exit", (code) => failed(new Error(`exited ${code}`)));
  });
  return {
    async release() {
      const exited = new Promise((done) => child.once("exit", done));
      writeFileSync(release, "");
      await exited;
    },
  };
}
