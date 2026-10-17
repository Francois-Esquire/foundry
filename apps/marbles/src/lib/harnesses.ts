import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

import type { TurnExecutorRef } from "@foundry/models";

import { ModelManager } from "@foundry/models";
import { claudeCodeProvider } from "@foundry/models/claude-code";
import { codexProvider } from "@foundry/models/codex";
import { CLI_HARNESSES } from "~/lib/cli-harnesses";
import { CLI_EXECUTORS } from "~/lib/executor";

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

export const CLAUDE_CODE: TurnExecutorRef =
  CLI_HARNESSES["claude-code"].executor;

export const CODEX: TurnExecutorRef = CLI_HARNESSES.codex.executor;

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
  return CLI_EXECUTORS.filter(
    (executor) => only.length === 0 || only.includes(executor.harness)
  );
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
