import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { ProviderModelDefinition, TurnLimit } from "@foundry/models";
import { CLAUDE_CODE_DEFAULT_MODELS } from "@foundry/models/claude-code";
import { PI_DEFAULT_MODELS } from "@foundry/models/pi";
import type { CliHarness, TurnExecutorRef } from "~/lib/cli-harnesses";
import { CLI_HARNESSES } from "~/lib/cli-harnesses";

export function which(
  name: string,
  path: string | undefined = process.env.PATH
): string | null {
  for (const dir of (path ?? "").split(delimiter)) {
    if (dir === "") {
      continue;
    }
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
    } catch {
      continue;
    }
    return candidate;
  }
  return null;
}

export const CLAUDE_CODE: TurnExecutorRef =
  CLI_HARNESSES["claude-code"].executor;

export const CODEX: TurnExecutorRef = CLI_HARNESSES.codex.executor;
export const PI: TurnExecutorRef = CLI_HARNESSES.pi.executor;

// biome-ignore lint/performance/noBarrelFile: Preserve the public selector import while keeping the engine independent of CLI providers.
export { selectExecutor } from "./executor";

export const CLI_PROVIDER_FACTS: Readonly<
  Record<
    CliHarness,
    {
      readonly models: readonly ProviderModelDefinition[];
      readonly turnLimit: TurnLimit;
    }
  >
> = {
  "claude-code": { models: CLAUDE_CODE_DEFAULT_MODELS, turnLimit: "native" },
  codex: { models: [], turnLimit: "unsupported" },
  pi: { models: PI_DEFAULT_MODELS, turnLimit: "unsupported" },
};
