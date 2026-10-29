import { usage } from "@foundry/usage";

/**
 * Marbles adds the signed-in default accounts (`anthropic` for Claude Code,
 * `openai` for Codex) to the shared `usage` before any step can run, so a
 * step queries them without initializing anything. Initializing only looks
 * for each login; it asks no provider for limits. A failure is reported and
 * leaves Marbles running, without the accounts it could not add; the next
 * start tries again.
 */

let initialized: Promise<void> | undefined;

/** Add the default accounts once per process; resolves either way. */
export function initializeUsage(
  warn: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  }
): Promise<void> {
  initialized ??= usage.initialize().then(
    () => undefined,
    (error: unknown) => {
      initialized = undefined;
      warn(
        `[usage] could not add the default accounts: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  );
  return initialized;
}
