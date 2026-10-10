import { resolve } from "node:path";
import { spawn } from "bun";

/** The built CLI; tests wait for the package build. */
export const CLI = resolve(import.meta.dirname, "../../dist/lib/atlas.js");

/** Starts the built CLI under the running Bun, with stdout and stderr piped. */
export function spawnCli(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined> = process.env
) {
  return spawn([process.execPath, CLI, ...args], {
    cwd,
    env,
    stderr: "pipe",
    stdout: "pipe",
  });
}
