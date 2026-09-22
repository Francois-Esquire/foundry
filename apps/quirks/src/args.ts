import { homedir } from "node:os";
import { join } from "node:path";

export interface Args {
  readonly command: string | undefined;
  readonly config: string;
  readonly dry: boolean;
  readonly inputJson: string | undefined;
  readonly name: string | undefined;
  /** `--harness` values in order; empty keeps every detected harness. */
  readonly only: readonly string[];
  readonly state: string;
  readonly target: string | undefined;
}

export function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const only: string[] = [];
  let dry = false;
  let config = "./quirks.config.ts";
  let state = join(homedir(), ".foundry", "quirks");
  let inputJson: string | undefined;

  const argumentsIterator = argv.values();
  for (const arg of argumentsIterator) {
    if (arg === "--dry") {
      dry = true;
    } else if (arg === "--config") {
      config = argumentsIterator.next().value ?? config;
    } else if (arg === "--state") {
      state = argumentsIterator.next().value ?? state;
    } else if (arg === "--input") {
      inputJson = argumentsIterator.next().value;
    } else if (arg === "--harness") {
      const id = argumentsIterator.next().value;
      if (id) {
        only.push(id);
      }
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }

  const [requested = "run", name, target] = positional;
  const command =
    argv.includes("--help") || argv.includes("-h") ? "help" : requested;
  return { command, config, dry, inputJson, name, only, state, target };
}
