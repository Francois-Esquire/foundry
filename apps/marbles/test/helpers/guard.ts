import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { layout } from "~/layout";
import { recordProcess } from "./processes";
import { RUN_ENV, runRecords } from "./runs";

const root = process.env[RUN_ENV];
const canonicalRoot = root === undefined ? undefined : canonical(root);
const inRun = (path: string) =>
  canonicalRoot !== undefined &&
  canonical(path).startsWith(`${canonicalRoot}${sep}`);
if (!(root !== undefined && inRun(layout().home) && inRun(homedir()))) {
  throw new Error(
    `marbles tests: this process would use the developer's home (Foundry home ${layout().home}, HOME ${homedir()}); run them through the suite's setup`
  );
}
recordProcess(join(runRecords(root), "workers"), process.pid, false);

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(canonical(parent), basename(path));
  }
}
