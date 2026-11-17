import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { generateMigrations } from "../../drizzle.generate";
import { configureProviders } from "./providers";

const RUN_PARENT = "/tmp";

export default function setup(): () => void {
  generateMigrations();
  const root = mkdtempSync(join(RUN_PARENT, "marbles-run-"));
  const home = join(root, "home");
  mkdirSync(home);
  process.env.TMPDIR = root;
  process.env.FOUNDRY_HOME = home;
  process.env.FOUNDRY_MODELS_DEV_URL = "";
  configureProviders(join(home, "marbles"));
  return () => removeRunRoot(root);
}

function removeRunRoot(root: string): void {
  try {
    rmSync(root, { maxRetries: 3, recursive: true });
  } catch (error) {
    console.warn(
      `marbles tests: could not remove the run's temp root ${root}: ${String(error)}`
    );
  }
}
