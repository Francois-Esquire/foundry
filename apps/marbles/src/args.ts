import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_SOURCE } from "~/source";

export interface Args {
  /** Shared Artifact store; the feed lives here. Defaults beside the state root. */
  readonly artifacts: string;
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

/** Flags that take the next argument; a later occurrence wins. */
const VALUE_FLAGS = {
  "--artifacts": "artifacts",
  "--config": "config",
  "--input": "inputJson",
  "--source": "config",
  "--state": "state",
} as const;
type ValueFlag = keyof typeof VALUE_FLAGS;

function isValueFlag(arg: string): arg is ValueFlag {
  return Object.hasOwn(VALUE_FLAGS, arg);
}

export function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const only: string[] = [];
  const values: Partial<Record<(typeof VALUE_FLAGS)[ValueFlag], string>> = {};
  let dry = false;

  const argumentsIterator = argv.values();
  for (const arg of argumentsIterator) {
    // `--dry` was the flag's first spelling. Left unrecognised it would parse
    // as a positional and the command would run for real.
    if (arg === "--dry-run" || arg === "--dry") {
      dry = true;
    } else if (isValueFlag(arg)) {
      const { value } = argumentsIterator.next();
      if (value !== undefined) {
        values[VALUE_FLAGS[arg]] = value;
      }
    } else if (arg === "--harness") {
      const id = argumentsIterator.next().value;
      if (id) {
        only.push(id);
      }
    } else {
      positional.push(arg);
    }
  }

  const [requested = "run", name, target] = positional;
  const command =
    argv.includes("--help") || argv.includes("-h") ? "help" : requested;
  const state = values.state ?? join(homedir(), ".foundry", "marbles");
  return {
    // `~/.foundry/marbles` → `~/.foundry/artifacts`: a custom --state keeps
    // its feed beside it rather than in the user's home.
    artifacts: values.artifacts ?? join(dirname(resolve(state)), "artifacts"),
    command,
    config: values.config ?? DEFAULT_SOURCE,
    dry,
    inputJson: values.inputJson,
    name,
    only,
    state,
    target,
  };
}
