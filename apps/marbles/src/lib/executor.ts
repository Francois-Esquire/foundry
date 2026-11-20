import type { ModelManager } from "@foundry/models";
import { servesKind } from "@foundry/models";
import type { TurnExecutorRef } from "~/lib/cli-harnesses";
import { CLI_HARNESSES, harnessOf } from "~/lib/cli-harnesses";

export function selectExecutor(models: ModelManager): TurnExecutorRef {
  if (
    !models.providers.some(
      (candidate) => servesKind(candidate, "text") && candidate.available
    )
  ) {
    throw new Error(
      "No configured model provider is available. Install Claude Code, Codex, or Pi, or configure another provider."
    );
  }
  const chosen = models.resolve("text");
  const provider = models.providers.find(({ id }) => id === chosen.provider);
  const preferred = CLI_HARNESSES.pi.executor;
  const route =
    preferred.provider === chosen.provider &&
    provider?.defaults?.text === undefined &&
    provider?.models.some(
      (entry) => entry.id === preferred.model && entry.kind === "text"
    )
      ? models.resolve("text", {
          model: preferred.model,
          provider: chosen.provider,
        })
      : chosen;
  return {
    harness: harnessOf(route.provider),
    model: route.model,
    provider: route.provider,
  };
}
