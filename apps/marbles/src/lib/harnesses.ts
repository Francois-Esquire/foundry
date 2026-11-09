import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type {
  ModelManager,
  ProviderModelDefinition,
  TurnLimit,
} from "@foundry/models";
import { servesKind } from "@foundry/models";
import { CLAUDE_CODE_DEFAULT_MODELS } from "@foundry/models/claude-code";
import { CODEX_DEFAULT_MODELS } from "@foundry/models/codex";
import { PI_DEFAULT_MODELS } from "@foundry/models/pi";
import type { CliHarness, TurnExecutorRef } from "~/lib/cli-harnesses";
import { CLI_HARNESS_IDS, CLI_HARNESSES, harnessOf } from "~/lib/cli-harnesses";

/** First executable named `name` on `path`, or null. */
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
      return candidate;
    } catch {
      // Continue searching when a candidate is inaccessible.
    }
  }
  return null;
}

export const CLAUDE_CODE: TurnExecutorRef =
  CLI_HARNESSES["claude-code"].executor;

export const CODEX: TurnExecutorRef = CLI_HARNESSES.codex.executor;
export const PI: TurnExecutorRef = CLI_HARNESSES.pi.executor;

/** Each CLI harness's default route, in preference order. */
const CLI_EXECUTORS: readonly TurnExecutorRef[] = CLI_HARNESS_IDS.map(
  (id) => CLI_HARNESSES[id].executor
);

/**
 * The default route for a turn: the first available provider serving text,
 * in the manager's order.
 */
export function selectExecutor(models: ModelManager): TurnExecutorRef {
  const provider = models.providers.find(
    (registered) => servesKind(registered, "text") && registered.available
  );
  if (!provider) {
    throw new Error(
      "No configured model provider is available. Install Claude Code, Codex, or Pi, or configure another provider."
    );
  }
  // Keep each CLI harness's established default rather than its first model.
  const preferred = CLI_EXECUTORS.find(
    (executor) => executor.provider === provider.id
  )?.model;
  const model = provider.models.some((entry) => entry.id === preferred)
    ? preferred
    : undefined;
  const route = models.resolve("text", {
    provider: provider.id,
    ...(model === undefined ? {} : { model }),
  });
  return {
    harness: harnessOf(route.provider),
    model: route.model,
    provider: route.provider,
  };
}

/** What each CLI harness's provider lists and how it limits turns, without building one. */
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
  codex: { models: CODEX_DEFAULT_MODELS, turnLimit: "unsupported" },
  pi: { models: PI_DEFAULT_MODELS, turnLimit: "unsupported" },
};
