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

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry") {
      dry = true;
    } else if (arg === "--config") {
      config = argv[++i] ?? config;
    } else if (arg === "--state") {
      state = argv[++i] ?? state;
    } else if (arg === "--input") {
      inputJson = argv[++i];
    } else if (arg === "--harness") {
      const id = argv[++i];
      if (id) {
        only.push(id);
      }
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }

  const [command, name, target] = positional;
  return { command, config, dry, inputJson, name, only, state, target };
}
