import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { SPAWN_RECORD_ENV } from "~/process/spawned";
import {
  configureProviders,
  makeProvidersTemplate,
  PROVIDERS_TEMPLATE_ENV,
} from "./providers";
import { privateBase, RUN_ENV, startRun, sweepFinishedRuns } from "./runs";

const RUN_PARENT =
  process.env.MARBLES_TEST_RUNS ||
  `/tmp/marbles-runs-${String(process.getuid?.() ?? "user")}`;

const USER_HOME = "user";

export default async function setup(
  project: TestProject
): Promise<() => Promise<void>> {
  privateBase(RUN_PARENT);
  await sweepFinishedRuns(RUN_PARENT);
  const run = startRun(RUN_PARENT);
  const home = join(run.root, "home");
  const user = join(run.root, USER_HOME);
  mkdirSync(home);
  mkdirSync(user);
  writeFileSync(
    join(user, ".foundry"),
    "Not a directory: Marbles tests name their Foundry home with FOUNDRY_ROOT.\n"
  );
  const template = await makeProvidersTemplate(run.root);
  project.config.env = {
    ...project.config.env,
    BUN_INSTALL_CACHE_DIR:
      process.env.BUN_INSTALL_CACHE_DIR ??
      join(process.env.HOME ?? user, ".bun", "install", "cache"),
    [RUN_ENV]: run.root,
    [SPAWN_RECORD_ENV]: join(run.records, "run"),
    FOUNDRY_MODELS_DEV_URL: "",
    FOUNDRY_ROOT: home,
    HOME: user,
    TMPDIR: run.root,
    [PROVIDERS_TEMPLATE_ENV]: template,
  };
  configureProviders(join(home, "marbles"), template);
  return () => run.finish();
}
