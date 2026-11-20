import type { ChildProcess } from "node:child_process";
import { spawn as spawnNode } from "node:child_process";
import { resolve } from "node:path";
import { spawn } from "bun";

export const CLI = resolve(import.meta.dirname, "../../dist/lib/spyglass.js");

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

export function spawnDetached(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>
): ChildProcess {
  return spawnNode(process.execPath, args, {
    cwd,
    detached: true,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
}
