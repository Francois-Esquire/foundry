import { parseArgs } from "node:util";
import { resolveSite } from "../lib/codemod";
import type { Site } from "../lib/codemod-types";
import type { LensId } from "../lib/lenses/lens-types";
import { LENS_IDS } from "../lib/lenses/lens-types";
import type { RenderDensity, RenderFormat } from "../lib/render/context";
import { RENDER_DENSITIES, RENDER_FORMATS } from "../lib/render/context";
import { checkPort, DEFAULT_PORT } from "../lib/serve";
import { overlapRefusal, resolveRoot } from "../lib/state";

export class UsageError extends Error {
  override readonly name = "UsageError";
}

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
  write: { type: "boolean" },
} as const;

interface SharedFlags {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly state: string | undefined;
}

interface CommandFlags {
  readonly density: RenderDensity;
  readonly format: RenderFormat | undefined;
  readonly history: boolean;
  readonly "no-open": boolean;
  readonly port: number | undefined;
  readonly write: boolean;
}
type CommandFlag = keyof CommandFlags;

type OptionName = keyof typeof OPTIONS;

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

function usageErrorFrom(error: unknown): UsageError {
  return new UsageError(messageOf(error), { cause: error });
}

export type Command =
  | "apply"
  | "check"
  | "export"
  | "lens"
  | "open"
  | "plan"
  | "report"
  | "scan"
  | "serve";

interface OnePath {
  readonly paths: readonly [string];
}

interface Paths {
  readonly paths: readonly [string, ...string[]];
}

function shortName(command: Command): string {
  return command === "open" ? "spyglass" : command;
}

function spelling(command: Command): string {
  return command === "open"
    ? shortName(command)
    : `spyglass ${shortName(command)}`;
}

function onePath(
  command: Command,
  words: readonly string[],
  cwd: string
): OnePath {
  const [path = cwd, ...more] = words;
  if (more.length > 0) {
    throw new UsageError(
      `${spelling(command)} reads one workspace's dataset; give one path.`
    );
  }
  return { paths: [path] };
}

function viewerPath(
  command: "export" | "open" | "serve",
  words: readonly string[],
  cwd: string
): OnePath {
  const [path = cwd, ...more] = words;
  if (more.length > 0) {
    throw new UsageError(
      `${spelling(command)} opens the viewer, which draws one workspace at a time; give one path. To scan several workspaces as a collection, use spyglass scan.`
    );
  }
  return { paths: [path] };
}

function somePaths(words: readonly string[], cwd: string): Paths {
  const [path = cwd, ...more] = words;
  return { paths: [path, ...more] };
}

export type Workspaces =
  | { readonly root: string }
  | { readonly roots: readonly [string, ...string[]] };

export async function workspacesOf(
  paths: readonly [string, ...string[]]
): Promise<Workspaces> {
  const [only, ...more] = paths;
  if (more.length === 0) {
    return { root: only };
  }
  const given = new Map<string, string>();
  for (const path of paths) {
    const root = await resolveRoot(path);
    const earlier = given.get(root);
    if (earlier !== undefined) {
      throw new UsageError(
        `${path} names the same workspace as ${earlier}, ${root}; give each workspace once.`
      );
    }
    given.set(root, path);
  }
  const overlap = overlapRefusal([...given.keys()]);
  if (overlap !== undefined) {
    throw new UsageError(overlap);
  }
  return { roots: paths };
}

function needed(
  command: "apply" | "export" | "lens" | "plan" | "report",
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
  readonly flags: readonly CommandFlag[];
  readonly read: (words: readonly string[], cwd: string) => OnePath | Paths;
  readonly summary: string;
  readonly usage: string;
}

const COMMANDS = {
  apply: {
    flags: ["write", "format", "density"],
    read: (words: readonly string[], cwd: string) => {
      const [word, rest] = needed("apply", "an opportunity", words);
      return { site: siteOf(word), ...onePath("apply", rest, cwd) };
    },
    summary: "Preview a planned change; write and verify it with --write",
    usage: "spyglass apply <opportunity> [path...]",
  },
  check: {
    flags: ["format", "density"],
    read: (words: readonly string[], cwd: string) =>
      onePath("check", words, cwd),
    summary: "Check the workspace's rules against the saved dataset",
    usage: "spyglass check [path...]",
  },
  export: {
    flags: [],
    read: (words: readonly string[], cwd: string) => {
      const [directory, rest] = needed("export", "a directory", words);
      return { directory, ...viewerPath("export", rest, cwd) };
    },
    summary: "Write a static viewer of the saved dataset to <dir>",
    usage: "spyglass export <dir> [path]",
  },
  lens: {
    flags: ["format", "density"],
    read: (words: readonly string[], cwd: string) => {
      const [id, rest] = needed("lens", "a lens", words);
      return { lens: lensId(id), ...onePath("lens", rest, cwd) };
    },
    summary: "Print a lens from the saved dataset",
    usage: "spyglass lens <id> [path...]",
  },
  open: {
    flags: ["history", "port", "no-open"],
    read: (words: readonly string[], cwd: string) =>
      viewerPath("open", words, cwd),
    summary: "Scan, serve, and open the browser",
    usage: "spyglass [path]",
  },
  plan: {
    flags: ["format", "density"],
    read: (words: readonly string[], cwd: string) => {
      const [word, rest] = needed("plan", "an opportunity", words);
      return { site: siteOf(word), ...onePath("plan", rest, cwd) };
    },
    summary:
      "Plan one opportunity and authorize it; writes nothing in the workspace",
    usage: "spyglass plan <opportunity> [path...]",
  },
  report: {
    flags: ["format", "density"],
    read: (words: readonly string[], cwd: string) => {
      const [name, rest] = needed("report", "a package", words);
      return { package: name, ...onePath("report", rest, cwd) };
    },
    summary: "Print a package report from the saved dataset",
    usage: "spyglass report <package> [path...]",
  },
  scan: {
    flags: ["history"],
    read: (words: readonly string[], cwd: string) => somePaths(words, cwd),
    summary: "Scan and save each workspace's dataset",
    usage: "spyglass scan [path...]",
  },
  serve: {
    flags: ["port", "no-open"],
    read: (words: readonly string[], cwd: string) =>
      viewerPath("serve", words, cwd),
    summary: "Serve the saved dataset without scanning",
    usage: "spyglass serve [path]",
  },
} as const satisfies { readonly [C in Command]: CommandSpec };

const COMMAND_ORDER = [
  "open",
  "scan",
  "serve",
  "report",
  "lens",
  "check",
  "plan",
  "apply",
  "export",
] as const satisfies readonly Command[];

type FlagsOf<C extends Command> = (typeof COMMANDS)[C]["flags"][number];

export type ArgsOf<C extends Command> = C extends Command
  ? { readonly command: C } & SharedFlags &
      Pick<CommandFlags, FlagsOf<C>> &
      ReturnType<(typeof COMMANDS)[C]["read"]>
  : never;

type Args = ArgsOf<Command>;

export type CommandLine = Args | { readonly command: "help" };

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
  state: ["--state <path>", "State root (default: ~/.foundry/spyglass)"],
  write: ["--write", "write the change, verify it, then scan again"],
};

const FLAG_ORDER = [
  "state",
  "history",
  "port",
  "no-open",
  "write",
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
    "Spyglass — workspace analysis and a local viewer",
    "",
    ...commands,
    "",
    "The path defaults to the current directory. scan reads several paths as one collection;",
    "the viewer (spyglass, serve, export) and the other commands read one workspace.",
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
  return {
    command,
    json: values.json ?? false,
    quiet: values.quiet ?? false,
    state: values.state,
    ...own,
    ...parsed,
  } as CommandLine;
}

const JSON_PRINTS: Partial<Record<Command, string>> = {
  apply: "the apply's result",
  check: "the check's result",
  lens: "the lens as saved",
  plan: "the plan's result",
};

type Values = ReturnType<typeof readOptions>["values"];

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
    write: values.write ?? false,
  };
}

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

function siteOf(word: string): Site {
  try {
    return resolveSite(word);
  } catch (error) {
    throw usageErrorFrom(error);
  }
}

function lensId(word: string): LensId {
  return chosen("spyglass lens", LENS_IDS, word);
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
