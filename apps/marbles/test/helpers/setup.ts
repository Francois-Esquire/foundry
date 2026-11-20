import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

export default async function setup(): Promise<() => Promise<void>> {
  privateBase(RUN_PARENT);
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
  process.env.BUN_INSTALL_CACHE_DIR ??= join(
    process.env.HOME ?? user,
    ".bun",
    "install",
    "cache"
  );
  process.env[RUN_ENV] = run.root;
  process.env[SPAWN_RECORD_ENV] = join(run.records, "run");
  process.env.TMPDIR = run.root;
  process.env.HOME = user;
  process.env.FOUNDRY_HOME = home;
  process.env.FOUNDRY_MODELS_DEV_URL = "";
  process.env[PROVIDERS_TEMPLATE_ENV] = await makeProvidersTemplate(run.root);
  configureProviders(join(home, "marbles"));
  return () => run.finish();
}
