import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { configureProviders } from "./providers";

/**
 * Directly under `/tmp`: a Unix socket path has 104 bytes, and fixtures add
 * their own directories below the run's root. The per-user macOS temp
 * directory takes about fifty of them by itself.
 */
const RUN_PARENT = "/tmp";

/**
 * One root per run, holding a Foundry home that is never the developer's,
 * with the CLI providers configured and no models.dev load, so no test
 * reaches the network. `TMPDIR` names the root, so every temp directory a
 * test makes is inside it. Set before workers start, so it is in their
 * environment and in that of every process they spawn: Bun hands a child
 * the environment it started with, not later changes to `process.env`.
 */
export default function setup(): () => void {
  const root = mkdtempSync(join(RUN_PARENT, "marbles-run-"));
  const home = join(root, "home");
  mkdirSync(home);
  process.env.TMPDIR = root;
  process.env.FOUNDRY_HOME = home;
  process.env.FOUNDRY_MODELS_DEV_URL = "";
  configureProviders(join(home, "marbles"));
  return () => removeRunRoot(root);
}

/**
 * Remove the root this run created, and only it: recursive removal deletes
 * a symbolic link inside it, not what the link points to. A process a test
 * left running may still be writing there; then this warns instead of
 * failing the run, and whatever could not be removed stays under
 * `/tmp/marbles-run-*` until it is deleted by hand or the system clears
 * `/tmp`. Nothing here stops that process.
 */
function removeRunRoot(root: string): void {
  try {
    rmSync(root, { maxRetries: 3, recursive: true });
  } catch (error) {
    console.warn(
      `marbles tests: could not remove the run's temp root ${root}: ${String(error)}`
    );
  }
}
