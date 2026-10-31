import { execFileSync } from "node:child_process";
import { expect, vi } from "vitest";
import { layout } from "~/layout";
import { daemonAlive } from "~/process/client";
import { cliArgs } from "./cli";

/** Ask the Marbles process under `state` to stop, and wait until it has. */
export async function stopDaemon(state: string): Promise<void> {
  execFileSync("bun", [...cliArgs("stop"), "--state", state], {
    stdio: "pipe",
  });
  const marbles = layout({ state });
  await vi.waitFor(() => expect(daemonAlive(marbles)).toBe(false), {
    interval: 100,
    timeout: 30_000,
  });
}
