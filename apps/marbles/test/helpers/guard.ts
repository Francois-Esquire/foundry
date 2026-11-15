import { homedir } from "node:os";
import { sep } from "node:path";
import { layout } from "~/layout";
import { RUN_ENV } from "./runs";

/**
 * Run before every test file: refuse to run unless both the Foundry home
 * this process resolves and its `HOME` are inside the run's root, so no
 * test reaches the developer's `~/.foundry`, the Marbles process that
 * serves it, or anything else in their home. The run's setup moves both
 * there; a worker without them was not started by it.
 */
const root = process.env[RUN_ENV];
const inRun = (path: string) =>
  root !== undefined && path.startsWith(`${root}${sep}`);
if (!(inRun(layout().home) && inRun(homedir()))) {
  throw new Error(
    `marbles tests: this process would use the developer's home (Foundry home ${layout().home}, HOME ${homedir()}); run them through the suite's setup`
  );
}
