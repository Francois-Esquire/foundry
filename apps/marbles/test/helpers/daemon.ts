import { execFileSync } from "node:child_process";
import { expect, vi } from "vitest";
import { daemonAlive } from "~/process/client";
import { cliArgs } from "./cli";
import type { TestHome } from "./home";

/**
 * Ask the Marbles process in `home` to stop, with `marbles stop`, and wait
 * until it has: for a test that goes on without it. The home's teardown
 * stops whatever is left either way.
 */
export async function stopDaemon(home: TestHome): Promise<void> {
  execFileSync("bun", cliArgs("stop"), { env: home.env, stdio: "pipe" });
  await vi.waitFor(() => expect(daemonAlive(home.layout)).toBe(false), {
    interval: 100,
    timeout: 30_000,
  });
}
