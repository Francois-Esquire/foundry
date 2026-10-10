import { parseArgs } from "node:util";
import { resolveSite } from "../lib/codemod";
import type { Site } from "../lib/codemod-types";
import type { LensId } from "../lib/lenses/lens-types";
import { LENS_IDS } from "../lib/lenses/lens-types";
import type { RenderDensity, RenderFormat } from "../lib/render/context";
import { RENDER_DENSITIES, RENDER_FORMATS } from "../lib/render/context";
import { checkPort, DEFAULT_PORT } from "../lib/serve";

/** A command line that cannot run: an unknown flag, a missing argument, or a bad value. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** Every option on the command line, as `parseArgs` reads it. */
const OPTIONS = {
  density: { type: "string" },
  format: { type: "string" },
  help: { short: "h", type: "boolean" },
  history: { type: "boolean" },
  json: { type: "boolean" },
  "no-open": { type: "boolean" },
  port: { type: "string" },
  quiet: { type: "boolean" },
  state: { type: "string" },
} as const;

/** The flags every command takes. */
interface SharedFlags {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly state: string | undefined;
}

/** The flags only some commands take, as parsed. */
interface CommandFlags {
  readonly density: RenderDensity;
  /** `undefined`: the CLI picks `terminal` on a terminal and `text` otherwise. */
  readonly format: RenderFormat | undefined;
  readonly history: boolean;
  readonly "no-open": boolean;
  /** `undefined`: `serve`'s default port. */
  readonly port: number | undefined;
}
type CommandFlag = keyof CommandFlags;

type OptionName = keyof typeof OPTIONS;

/** The options every command takes; any other must be in the command's own list. */
const SHARED = ["help", "json", "quiet", "state"] as const satisfies readonly (
  | keyof SharedFlags
  | "help"
)[];

function isShared(option: string): boolean {
  return SHARED.some((shared) => shared === option);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A failure to read the command line, as a usage error. */
function usageErrorFrom(error: unknown): UsageError {
  return new UsageError(messageOf(error), { cause: error });
}

/** Every command; `open` is the default, which has no name of its own. */
export type Command =
  | "check"
  | "export"
  | "lens"
  | "open"
  | "plan"
  | "report"
  | "scan"
  | "serve";

/** One workspace until collections read several; the parser reads `path...`. */
interface Paths {
  readonly paths: readonly [string];
}

const SEVERAL_PENDING =
  "Reading several workspaces at once is not supported yet.";

/** A command's name in the help's flag list: `atlas` for the default. */
function shortName(command: Command): string {
  return command === "open" ? "atlas" : command;
}

/** How a command is written in its usage errors. */
function spelling(command: Command): string {
  return command === "open"
    ? shortName(command)
    : `atlas ${shortName(command)}`;
}

function onePath(
  command: Command,
  words: readonly string[],
  cwd: string
): Paths {
  const [path = cwd, ...more] = words;
  if (more.length > 0) {
    throw new UsageError(
      `${spelling(command)} takes one workspace path. ${SEVERAL_PENDING}`
    );
  }
  return { paths: [path] };
}

/** The word a command needs before its path, as `report <package>`. */
function needed(
  command: "export" | "lens" | "plan" | "report",
  what: string,
  words: readonly string[]
): [string, readonly string[]] {
  const [first, ...rest] = words;
  if (first === undefined) {
    throw new UsageError(
      `${spelling(command)} needs ${what}: ${COMMANDS[command].usage}`
    );
  }
  return [first, rest];
}

interface CommandSpec {
  /** The flags it takes beyond the shared ones; the parser refuses any other. */
  readonly flags: readonly CommandFlag[];
  /** Reads the words after the command's name. */
  readonly read: (words: readonly string[], cwd: string) => Paths;
  readonly summary: string;
  readonly usage: string;
}

/**
 * Every command: how it is written, what it does, the flags it takes, and
 * how it reads the words after its name. The parser and the help are both
 * written from this table.
 */
const COMMANDS = {
  check: {
    flags: ["format", "density"],
    read: (words: readonly string[], cwd: string) =>
      onePath("check", words, cwd),
    summary: "Check the workspace's rules against the saved dataset",
    usage: "atlas check [path...]",
  },
  export: {
    flags: [],
    read: (words: readonly string[], cwd: string) => {
      const [directory, rest] = needed("export", "a directory", words);
      return { directory, ...onePath("export", rest, cwd) };
    },
    summary: "Write a static viewer of the saved dataset to <dir>",
    usage: "atlas export <dir> [path...]",
  },
  lens: {
    flags: ["format", "density"],
    read: (words: readonly string[], cwd: string) => {
      const [id, rest] = needed("lens", "a lens", words);
      return { lens: lensId(id), ...onePath("lens", rest, cwd) };
    },
    summary: "Print a lens from the saved dataset",
    usage: "atlas lens <id> [path...]",
  },
  open: {
    flags: ["history", "port", "no-open"],
    read: (words: readonly string[], cwd: string) =>
      onePath("open", words, cwd),
    summary: "Scan a workspace, serve its dataset, and open the browser",
    usage: "atlas [path...]",
  },
  plan: {
    flags: ["format", "density"],
    read: (words: readonly string[], cwd: string) => {
      const [word, rest] = needed("plan", "an opportunity", words);
      return { site: siteOf(word), ...onePath("plan", rest, cwd) };
    },
    summary:
      "Plan one opportunity and authorize it; writes nothing in the workspace",
    usage: "atlas plan <opportunity> [path...]",
  },
  report: {
    flags: ["format", "density"],
    read: (words: readonly string[], cwd: string) => {
      const [name, rest] = needed("report", "a package", words);
      return { package: name, ...onePath("report", rest, cwd) };
    },
    summary: "Print a package report from the saved dataset",
    usage: "atlas report <package> [path...]",
  },
  scan: {
    flags: ["history"],
    read: (words: readonly string[], cwd: string) =>
      onePath("scan", words, cwd),
    summary: "Scan and save the dataset",
    usage: "atlas scan [path...]",
  },
  serve: {
    flags: ["port", "no-open"],
    read: (words: readonly string[], cwd: string) =>
      onePath("serve", words, cwd),
    summary: "Serve the saved dataset without scanning",
    usage: "atlas serve [path...]",
  },
} as const satisfies { readonly [C in Command]: CommandSpec };

/** The help's order: the default command first. */
const COMMAND_ORDER = [
  "open",
  "scan",
  "serve",
  "report",
  "lens",
  "check",
  "plan",
  "export",
] as const satisfies readonly Command[];

type FlagsOf<C extends Command> = (typeof COMMANDS)[C]["flags"][number];

/** A command line for one command: its name, its flags, and its positionals. */
export type ArgsOf<C extends Command> = C extends Command
  ? { readonly command: C } & SharedFlags &
      Pick<CommandFlags, FlagsOf<C>> &
      ReturnType<(typeof COMMANDS)[C]["read"]>
  : never;

/** A command line that can run. */
type Args = ArgsOf<Command>;

/** What a command line asks for: a command, or the help. */
export type CommandLine = Args | { readonly command: "help" };

/** What each flag does, for the help; a command flag's text follows the commands that take it. */
const FLAG_HELP: Readonly<Record<OptionName, [string, string]>> = {
  density: [
    "--density <density>",
    `${RENDER_DENSITIES.join(", ")} (default: normal)`,
  ],
  format: [
    "--format <format>",
    `${RENDER_FORMATS.join(", ")} (default: terminal; text when piped)`,
  ],
  help: ["--help, -h", "Show this help"],
  history: ["--history", "analyze Git checkpoints as well"],
  json: ["--json", "Print the result as one line of JSON"],
  "no-open": ["--no-open", "do not open the browser"],
  port: [
    "--port <number>",
    `local port (default: ${DEFAULT_PORT}; 0 chooses a free port)`,
  ],
  quiet: ["--quiet", "Print no progress"],
  state: ["--state <path>", "State root (default: ~/.foundry/atlas)"],
};

const FLAG_ORDER = [
  "state",
  "history",
  "port",
  "no-open",
  "format",
  "density",
  "json",
  "quiet",
  "help",
] as const satisfies readonly OptionName[];

const NAMED_COMMANDS = COMMAND_ORDER.filter((command) => command !== "open");

function takes(command: Command, option: string): boolean {
  return COMMANDS[command].flags.some((flag: string) => flag === option);
}

/** The longest usage and two spaces. */
const COMMAND_COLUMN =
  Math.max(...COMMAND_ORDER.map((command) => COMMANDS[command].usage.length)) +
  2;
const FLAG_COLUMN = 22;

function helpText(): string {
  const commands = COMMAND_ORDER.map(
    (command) =>
      `  ${COMMANDS[command].usage.padEnd(COMMAND_COLUMN)}${COMMANDS[command].summary}`
  );
  const flags = FLAG_ORDER.map((flag) => {
    const [written, text] = FLAG_HELP[flag];
    const only = isShared(flag)
      ? ""
      : `${COMMAND_ORDER.filter((command) => takes(command, flag))
          .map(shortName)
          .join(", ")}: `;
    return `  ${written.padEnd(FLAG_COLUMN)}${only}${text}`;
  });
  const names = NAMED_COMMANDS.map((command) => `./${command}`);
  return [
    "Atlas — workspace analysis and a local viewer",
    "",
    ...commands,
    "",
    "The path defaults to the current directory; one workspace at a time.",
    `A directory named like a command is written as a path: ${names.join(", ")}.`,
    "",
    ...flags,
    "",
    "Exit codes: 0 done, 1 failed, 2 bad arguments, 3 a rule broken (check).",
    "",
  ].join("\n");
}

export const HELP = helpText();

function isNamedCommand(word: string | undefined): word is Command {
  return NAMED_COMMANDS.some((command) => command === word);
}

/** Reads a command line; throws `UsageError` for one that cannot run. */
export function parseArguments(
  argv: readonly string[],
  cwd = process.cwd()
): CommandLine {
  const { values, positionals } = readOptions(argv);
  if (values.help) {
    return { command: "help" };
  }
  const [word, ...rest] = positionals;
  const command = isNamedCommand(word) ? word : "open";
  const taken: readonly CommandFlag[] = COMMANDS[command].flags;
  const refused = Object.keys(values).find(
    (option) => !(isShared(option) || takes(command, option))
  );
  if (refused !== undefined) {
    throw new UsageError(`${spelling(command)} does not take --${refused}.`);
  }
  const parsed = COMMANDS[command].read(
    command === "open" ? positionals : rest,
    cwd
  );
  const flags = commandFlags(values);
  if (values.json && (values.format ?? values.density) !== undefined) {
    throw new UsageError(
      `--json prints ${JSON_PRINTS[command] ?? "the report as saved"}; drop --format and --density.`
    );
  }
  const own = Object.fromEntries(taken.map((flag) => [flag, flags[flag]]));
  // The table pairs the command with its flags and positionals; the type
  // cannot follow `command` through the lookups above.
  return {
    command,
    json: values.json ?? false,
    quiet: values.quiet ?? false,
    state: values.state,
    ...own,
    ...parsed,
  } as CommandLine;
}

/** What `--json` prints for a command that also renders, in its usage error. */
const JSON_PRINTS: Partial<Record<Command, string>> = {
  check: "the check's result",
  lens: "the lens as saved",
  plan: "the plan's result",
};

type Values = ReturnType<typeof readOptions>["values"];

/** Unknown flags and flags missing their value are refused before anything else. */
function readOptions(argv: readonly string[]) {
  try {
    return parseArgs({
      allowPositionals: true,
      args: [...argv],
      options: OPTIONS,
      strict: true,
    });
  } catch (error) {
    throw usageErrorFrom(error);
  }
}

function commandFlags(values: Values): CommandFlags {
  return {
    density: oneOf("--density", RENDER_DENSITIES, values.density) ?? "normal",
    format: oneOf("--format", RENDER_FORMATS, values.format),
    history: values.history ?? false,
    "no-open": values["no-open"] ?? false,
    port: values.port === undefined ? undefined : parsePort(values.port),
  };
}

/** One of the allowed words; any other is a usage error that lists them. */
function chosen<T extends string>(
  what: string,
  allowed: readonly T[],
  value: string
): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) {
    const last = allowed.at(-1);
    throw new UsageError(
      `${what} takes ${allowed.slice(0, -1).join(", ")}, or ${last}.`
    );
  }
  return found;
}

function oneOf<T extends string>(
  flag: string,
  allowed: readonly T[],
  value: string | undefined
): T | undefined {
  return value === undefined ? undefined : chosen(flag, allowed, value);
}

/** An opportunity, by any of the words `resolveSite` reads; another shape is a usage error. */
function siteOf(word: string): Site {
  try {
    return resolveSite(word);
  } catch (error) {
    throw usageErrorFrom(error);
  }
}

/** A lens the dataset saves, by id. */
function lensId(word: string): LensId {
  return chosen("atlas lens", LENS_IDS, word);
}

function parsePort(value: string): number {
  const port = value ? Number(value) : Number.NaN;
  try {
    checkPort(port);
  } catch (error) {
    throw usageErrorFrom(error);
  }
  return port;
}
