import type { ModelManager, TurnExecutorRef } from "@foundry/models";

import { servesKind } from "@foundry/models";
import { CLI_HARNESS_IDS, CLI_HARNESSES } from "~/lib/cli-harnesses";

/**
 * Turn routing, kept apart from the CLI providers in `harnesses.ts` so the
 * engine reaches no CLI SDK until a CLI harness actually runs.
 */

/** Each CLI harness's default route, in preference order. */
export const CLI_EXECUTORS: readonly TurnExecutorRef[] = CLI_HARNESS_IDS.map(
  (id) => CLI_HARNESSES[id].executor
);

/**
 * The route for a turn, chosen from what the model manager has registered
 * rather than from what is on PATH: the named harness, or the first
 * available one in registration order.
 */
export function selectExecutor(
  models: ModelManager,
  harness?: string
): TurnExecutorRef {
  const candidates = models
    .list()
    .filter(
      (registered) =>
        servesKind(registered, "text") &&
        (harness === undefined || registered.harness === harness)
    );
  const provider = candidates.find((candidate) => candidate.available);
  if (!provider) {
    throw new Error(
      harness === undefined
        ? "No harness is available. Install Codex, Claude Code, or Pi, or register a model provider."
        : `The ${harness} harness is not available${candidates.length > 0 ? " on this machine" : ""}. Install it, choose another harness, or register a provider for it.`
    );
  }
  // Keep each CLI harness's established default rather than its first model.
  const preferred = CLI_EXECUTORS.find(
    (executor) => executor.provider === provider.id
  )?.model;
  const model = provider.models.some((entry) => entry.id === preferred)
    ? preferred
    : undefined;
  return models.resolveTextExecutor(model, provider.id, provider.harness);
}
