import { z } from "zod";
import { FIRST_PARTY_DRIVERS } from "~/host/guest/drivers";
import { which } from "~/host/which";
import type { CliHarness } from "~/lib/managers/cli-harnesses";
import { CLI_HARNESSES } from "~/lib/managers/cli-harnesses";
import type { Execution } from "~/lib/providers/plugins";

export const BIN = z.object({ binPath: z.string().optional() });
export type Bin = z.infer<typeof BIN>;

export function cli(
  name: string,
  settings: Bin,
  env: Readonly<Record<string, string>>
) {
  return settings.binPath ?? which(name, env.PATH || "");
}

export function guestOf(
  harness: CliHarness,
  env: Readonly<Record<string, string>>,
  bin: string | null
): Execution {
  return {
    ...(bin === null ? {} : { bin }),
    driver: FIRST_PARTY_DRIVERS[harness],
    env,
    guest: CLI_HARNESSES[harness],
    harness,
  };
}

export function scopedCli(
  name: "claude" | "codex",
  settings: Bin,
  env: Readonly<Record<string, string>>
): string | null {
  return settings.binPath || which(name, env.PATH || "");
}
