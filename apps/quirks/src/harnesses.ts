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
  // eslint-disable-next-line turbo/no-undeclared-env-vars -- the OS PATH, not app config
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
    } catch {}
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
