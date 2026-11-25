import { usage } from "@foundry/usage/node";

let initialized: Promise<void> | undefined;

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
