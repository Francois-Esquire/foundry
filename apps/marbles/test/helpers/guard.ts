import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { layout } from "~/layout";
import { recordProcess } from "./processes";
import { RUN_ENV, runRecords } from "./runs";

/**
 * Run before every test file, in the worker that runs it. It refuses to
 * run unless both the Foundry home this process resolves and its `HOME`
 * are inside the run's root, compared after resolving symbolic links, so
 * a link inside the root that points out of it does not pass. That keeps
 * a test from reaching the developer's `~/.foundry`, the Marbles process
 * that serves it, or anything else in their home. It also records the
 * worker itself, so a run killed outright can stop the workers it leaves.
 *
 * It checks this process when the file starts, and nothing later: not a
 * test that changes `process.env` afterwards, and not a child started
 * with an environment that drops both `FOUNDRY_HOME` and `HOME`, which
 * would resolve the real home from the system's user database. A child
 * that keeps `HOME` and drops `FOUNDRY_HOME`, as an MCP transport's
 * default environment does, gets the run's fake home, whose `.foundry` is
 * a file, and fails instead of using the developer's (see `setup.ts`).
 */
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

/**
 * `path` with every symbolic link resolved; a part that does not exist
 * yet is taken as written, below the nearest part that does.
 */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(canonical(parent), basename(path));
  }
}
