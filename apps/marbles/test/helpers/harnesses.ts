import type { ProviderModelDefinition, TurnLimit } from "@foundry/models";
import { CLAUDE_CODE_DEFAULT_MODELS } from "@foundry/models/providers/claude-code";
import { PI_DEFAULT_MODELS } from "@foundry/models/providers/pi";
import type { CliHarness, TurnExecutorRef } from "~/lib/managers/cli-harnesses";
import { CLI_HARNESSES } from "~/lib/managers/cli-harnesses";

export const CLAUDE_CODE: TurnExecutorRef =
  CLI_HARNESSES["claude-code"].executor;

export const CODEX: TurnExecutorRef = CLI_HARNESSES.codex.executor;
export const PI: TurnExecutorRef = CLI_HARNESSES.pi.executor;

export const CLI_PROVIDER_FACTS: Readonly<
  Record<
    CliHarness,
    {
      readonly defaults?: { readonly text: string };
      readonly models: readonly ProviderModelDefinition[];
      readonly turnLimit: TurnLimit;
    }
  >
> = {
  "claude-code": {
    defaults: { text: CLAUDE_CODE.model },
    models: CLAUDE_CODE_DEFAULT_MODELS,
    turnLimit: "native",
  },
  codex: { models: [], turnLimit: "unsupported" },
  pi: { models: PI_DEFAULT_MODELS, turnLimit: "unsupported" },
};
