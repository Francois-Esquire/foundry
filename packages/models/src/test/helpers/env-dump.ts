import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** An executable that records the environment it was started with, then fails. */
export function envDumpExecutable(): {
  readonly bin: string;
  read(): Record<string, string> | undefined;
  remove(): void;
} {
  const dir = mkdtempSync(join(tmpdir(), "models-env-"));
  const bin = join(dir, "cli");
  const dump = join(dir, "env.json");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env));
process.exit(1);
`
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    read: () =>
      existsSync(dump)
        ? (JSON.parse(readFileSync(dump, "utf8")) as Record<string, string>)
        : undefined,
    remove: () => rmSync(dir, { force: true, recursive: true }),
  };
}

/** An executable that stays alive, reading stdin and answering nothing, and records each pid it ran as. */
export function silentExecutable(): {
  readonly bin: string;
  pids(): number[];
  remove(): void;
} {
  const dir = mkdtempSync(join(tmpdir(), "models-silent-"));
  const bin = join(dir, "cli");
  const log = join(dir, "pids");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(log)}, process.pid + "\\n");
process.stdin.resume();
setInterval(() => undefined, 1000);
`
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    pids: () =>
      existsSync(log)
        ? readFileSync(log, "utf8").split("\n").filter(Boolean).map(Number)
        : [],
    remove: () => rmSync(dir, { force: true, recursive: true }),
  };
}
