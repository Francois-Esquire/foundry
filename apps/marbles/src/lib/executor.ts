import type { ModelManager } from "@foundry/models";
import { servesKind } from "@foundry/models";
import type { TurnExecutorRef } from "~/lib/cli-harnesses";
import { CLI_HARNESS_IDS, CLI_HARNESSES, harnessOf } from "~/lib/cli-harnesses";

// Kept apart from provider implementations so the embedded engine loads no CLI SDK.
/** Each CLI harness's default route, in preference order. */
const CLI_EXECUTORS: readonly TurnExecutorRef[] = CLI_HARNESS_IDS.map(
  (id) => CLI_HARNESSES[id].executor
);

/**
 * The default route for a turn: the manager's choice of provider, which skips
 * any a policy refuses, at the model configured as its text default, else the
 * CLI harness's established default, else its first text model.
 */
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
  const preferred = CLI_EXECUTORS.find(
    (executor) => executor.provider === chosen.provider
  )?.model;
  const route =
    provider?.defaults?.text === undefined &&
    preferred !== undefined &&
    provider?.models.some(
      (entry) => entry.id === preferred && entry.kind === "text"
    )
      ? models.resolve("text", { model: preferred, provider: chosen.provider })
      : chosen;
  return {
    harness: harnessOf(route.provider),
    model: route.model,
    provider: route.provider,
  };
}
