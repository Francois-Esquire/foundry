import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configureProviders } from "./providers";
import { RUN_ENV, startRun, sweepFinishedRuns } from "./runs";

/**
 * Directly under `/tmp`: a Unix socket path has 104 bytes, and fixtures add
 * their own directories below the run's root. The per-user macOS temp
 * directory takes about fifty of them by itself.
 */
const RUN_PARENT = "/tmp";

/**
 * Where `HOME` points for the run. Its `.foundry` is a file, so a process
 * that resolves the default Foundry home, because it was started without
 * `FOUNDRY_HOME` but kept `HOME` (as an MCP transport's default
 * environment does), fails at once instead of using the developer's.
 */
const USER_HOME = "user";

/**
 * One run, after cleaning up what earlier runs that were killed left
 * behind. Its root holds a Foundry home that is never the developer's,
 * with the CLI providers configured and no models.dev load, so no test
 * reaches the network. `TMPDIR` names the root, so every temp directory a
 * test makes is inside it, and the run's marker goes to everything it
 * starts. Set before workers start, so it is in their environment and in
 * that of every process they spawn: Bun hands a child the environment it
 * started with, not later changes to `process.env`.
 */
export default async function setup(): Promise<() => Promise<void>> {
  await sweepFinishedRuns(RUN_PARENT);
  const run = startRun(RUN_PARENT);
  const home = join(run.root, "home");
  const user = join(run.root, USER_HOME);
  mkdirSync(home);
  mkdirSync(user);
  writeFileSync(
    join(user, ".foundry"),
    "Not a directory: Marbles tests name their Foundry home with FOUNDRY_HOME.\n"
  );
  // Bun keeps its package cache under HOME; the package test's install
  // would otherwise fetch every dependency again.
  process.env.BUN_INSTALL_CACHE_DIR ??= join(
    process.env.HOME ?? user,
    ".bun",
    "install",
    "cache"
  );
  process.env[RUN_ENV] = run.root;
  process.env.TMPDIR = run.root;
  process.env.HOME = user;
  process.env.FOUNDRY_HOME = home;
  process.env.FOUNDRY_MODELS_DEV_URL = "";
  configureProviders(join(home, "marbles"));
  return () => run.finish();
}
