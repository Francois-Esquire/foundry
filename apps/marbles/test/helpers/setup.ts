import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureProviders } from "./providers";

/**
 * A Foundry home for the run, never the developer's, with the CLI providers
 * configured, and no models.dev load, so no test reaches the network. Set
 * before workers start, so it is in their environment and in that of every
 * process they spawn: Bun hands a child the environment it started with, not
 * later changes to `process.env`.
 */
export default function setup(): () => void {
  const home = mkdtempSync(join(tmpdir(), "marbles-home-"));
  process.env.FOUNDRY_HOME = home;
  process.env.FOUNDRY_MODELS_DEV_URL = "";
  configureProviders(join(home, "marbles"));
  return () => rmSync(home, { force: true, recursive: true });
}
