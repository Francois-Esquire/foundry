import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

import type { TurnExecutorRef } from "@foundry/models";

import { ModelManager } from "@foundry/models";
import { claudeCodeProvider } from "@foundry/models/claude-code";
import { codexProvider } from "@foundry/models/codex";

/**
 * Machine detection, which `@foundry/models` deliberately never does: a
 * provider defaults to unavailable and the host pushes availability down.
 */

export interface HarnessAvailability {
  readonly claudeCode: boolean;
  readonly codex: string | null;
}

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
      // Ignore malformed candidates and continue scanning harness locations.
    }
  }
  return null;
}

export function detectHarnesses(): HarnessAvailability {
  return {
    claudeCode: which("claude") !== null,
    // Codex needs the absolute path, not just presence: a GUI-launched host
    // inherits only the system PATH and the SDK's bare `codex` finds nothing.
    codex: which("codex"),
  };
}

export const CLAUDE_CODE: TurnExecutorRef = {
  harness: "claude-code",
  model: "opus",
  provider: "claude-code",
};

export const CODEX: TurnExecutorRef = {
  harness: "codex",
  model: "gpt-5.5",
  provider: "codex",
};

/** Detection narrowed to `--harness`; an empty selection keeps every harness. */
export function selectedHarnesses(
  available: HarnessAvailability,
  only: readonly string[]
): HarnessAvailability {
  if (only.length === 0) {
    return available;
  }
  return {
    claudeCode: available.claudeCode && only.includes(CLAUDE_CODE.harness),
    codex: only.includes(CODEX.harness) ? available.codex : null,
  };
}

/** Every CLI harness `--harness` allows, installed or not: what `--dry-run` echoes. */
export function allowedExecutors(
  only: readonly string[]
): readonly TurnExecutorRef[] {
  return [CLAUDE_CODE, CODEX].filter(
    (executor) => only.length === 0 || only.includes(executor.harness)
  );
}

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
        registered.models.some((entry) => (entry.kind ?? "text") === "text") &&
        (harness === undefined || registered.harness === harness)
    );
  const provider = candidates.find((candidate) => candidate.available);
  if (!provider) {
    throw new Error(
      harness === undefined
        ? "No harness is available. Install Codex or Claude Code, or register a model provider."
        : `The ${harness} harness is not available${candidates.length > 0 ? " on this machine" : ""}. Install it, choose another harness, or register a provider for it.`
    );
  }
  // Keep each CLI harness's established default rather than its first model.
  const preferred = [CLAUDE_CODE, CODEX].find(
    (executor) => executor.provider === provider.id
  )?.model;
  const model = provider.models.some((entry) => entry.id === preferred)
    ? preferred
    : undefined;
  return models.resolveTextExecutor(model, provider.id, provider.harness);
}

/** Only the harnesses actually on this machine, in preference order. */
export function availableExecutors(
  available: HarnessAvailability
): readonly TurnExecutorRef[] {
  return [
    ...(available.claudeCode ? [CLAUDE_CODE] : []),
    ...(available.codex === null ? [] : [CODEX]),
  ];
}

/** A manager with both CLI harnesses registered at their detected state. */
export function harnessModels(available: HarnessAvailability): ModelManager {
  return new ModelManager({
    providers: [
      claudeCodeProvider({ config: { available: available.claudeCode } }),
      codexProvider({
        config: {
          available: available.codex !== null,
          ...(available.codex === null ? {} : { binPath: available.codex }),
        },
      }),
    ],
  });
}
