import { usage as nodeUsage } from "@foundry/usage/node";
import { setUsage } from "~/authoring/usage";

let initialized: Promise<void> | undefined;

export function initializeUsage(
  warn: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  }
): Promise<void> {
  setUsage(nodeUsage);
  initialized ??= nodeUsage.initialize().then(
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
