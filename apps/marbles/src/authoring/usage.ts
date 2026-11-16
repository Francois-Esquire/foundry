import { usage } from "@foundry/usage";

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
