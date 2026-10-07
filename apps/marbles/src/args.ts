import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { allowedExecutors } from "~/lib/harnesses";
import type { StarterId } from "~/onboarding/templates";
import { DEFAULT_STARTER, STARTERS } from "~/onboarding/templates";
import { DEFAULT_SOURCE } from "~/source";

/** A command line that names no command Marbles knows, or the wrong arguments. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

const STARTER_IDS = STARTERS.map((starter) => starter.id);
const STARTER_LIST = `${STARTER_IDS.slice(0, -1).join(", ")}, or ${STARTER_IDS.at(-1)}`;

function isStarter(id: string): id is StarterId {
  return STARTER_IDS.some((starter) => starter === id);
}

type NoPositionals = Record<never, never>;

/** What each command takes after its name, once parsed. */
interface Positionals {
  readonly help: NoPositionals;
  readonly init: { readonly starter: StarterId };
  readonly launchd: {
    readonly action: "install" | "uninstall";
    readonly schedule: string;
  };
  readonly list: NoPositionals;
  readonly roll: { readonly name: string };
  readonly run: NoPositionals;
  readonly sessions: NoPositionals;
  readonly status: NoPositionals;
}

export type Command = keyof Positionals;

/** A command and what followed it. */
type Parsed<C extends Command> = { readonly command: C } & Positionals[C];

/** No positionals after the command. */
const none =
  <C extends Command>(command: C) =>
  (positionals: readonly string[]): { readonly command: C } => {
    if (positionals.length > 0) {
      throw new UsageError(`${command} takes no arguments`);
    }
    return { command };
  };

/**
 * Every command and how it reads the positionals after its name. Run by
 * `parseArgs`, so a command line that cannot run is refused before anything
 * is loaded or written. The CLI pairs each command with what it needs and
 * how it runs.
 */
const GRAMMAR: {
  readonly [C in Command]: (positionals: readonly string[]) => Parsed<C>;
} = {
  // Whatever follows help is ignored: help is asked for, not run.
  help: () => ({ command: "help" }),
  init: ([starter = DEFAULT_STARTER, ...rest]) => {
    if (rest.length > 0 || !isStarter(starter)) {
      throw new UsageError(`init takes one starter: ${STARTER_LIST}`);
    }
    return { command: "init", starter };
  },
  launchd: ([action, schedule, ...rest]) => {
    if (action !== "install" && action !== "uninstall") {
      throw new UsageError("launchd takes install or uninstall");
    }
    if (schedule === undefined) {
      throw new UsageError("launchd needs a schedule");
    }
    if (rest.length > 0) {
      throw new UsageError("launchd takes one schedule");
    }
    return { action, command: "launchd", schedule };
  },
  list: none("list"),
  roll: ([name, ...rest]) => {
    if (name === undefined || rest.length > 0) {
      throw new UsageError("roll takes one workflow or schedule name");
    }
    return { command: "roll", name };
  },
  // `run` starts every trigger and takes no name; a name here would
  // otherwise be dropped and the dashboard opened instead.
  run: ([name]) => {
    if (name !== undefined) {
      throw new UsageError(
        `run takes no name. To run one now: marbles roll ${name}`
      );
    }
    return { command: "run" };
  },
  sessions: none("sessions"),
  status: none("status"),
};

function isCommand(name: string): name is Command {
  return Object.hasOwn(GRAMMAR, name);
}

/** Every harness `--harness` may select. */
const HARNESS_IDS = allowedExecutors([]).map((executor) => executor.harness);

/** The flags, which every command reads alike. */
export interface Flags {
  /** Shared Artifact store; the feed lives here. Defaults beside the state root. */
  readonly artifacts: string;
  readonly config: string;
  readonly dry: boolean;
  readonly inputJson: string | undefined;
  /** `--harness` values in order; empty keeps every detected harness. */
  readonly only: readonly string[];
  readonly state: string;
}

/** A command line for one command: its flags and its parsed positionals. */
export type ArgsOf<C extends Command> = Flags & Parsed<C>;

/** A command line that can run. */
export type Args = { readonly [C in Command]: ArgsOf<C> }[Command];

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

/** Refuse a `--harness` id Marbles does not have. */
function checkHarnesses(only: readonly string[]): void {
  const unknown = only.find((id) => !HARNESS_IDS.includes(id));
  if (unknown !== undefined) {
    throw new UsageError(
      `unknown harness "${unknown}"; --harness takes ${HARNESS_IDS.join(" or ")}`
    );
  }
}

/** The flags on a command line, and the words that are not flags, in order. */
function readFlags(argv: readonly string[]): {
  readonly flags: Flags;
  readonly positional: readonly string[];
} {
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

  const state = values.state ?? join(homedir(), ".foundry", "marbles");
  // `~/.foundry/marbles` → `~/.foundry/artifacts`: a custom --state keeps
  // its feed beside it rather than in the user's home.
  const artifacts =
    values.artifacts ?? join(dirname(resolve(state)), "artifacts");
  const flags = {
    artifacts,
    config: values.config ?? DEFAULT_SOURCE,
    dry,
    inputJson: values.inputJson,
    only,
    state,
  };
  return { flags, positional };
}

/** Read a command line; throws `UsageError` for one that cannot run. */
export function parseArgs(argv: readonly string[]): Args {
  const { flags, positional } = readFlags(argv);
  // Help wins over whatever else is on the line, a bad flag included.
  if (argv.includes("--help") || argv.includes("-h")) {
    return { ...flags, ...GRAMMAR.help([]) };
  }
  const [command = "run", ...positionals] = positional;
  if (!isCommand(command)) {
    throw new UsageError(`unknown command "${command}"`);
  }
  const parsed = GRAMMAR[command](positionals);
  checkHarnesses(flags.only);
  return { ...flags, ...parsed };
}
