import { createInterface } from "node:readline/promises";
import { dispose as disposeDefaultRuntime } from "~/authoring/runtime";
import {
  type CommandDefinition,
  type CommandGroup,
  type CommandNeeds,
  defineCommand,
  isFlag,
  type UsageEntry,
} from "~/cli/command";
import { dashboardCommand } from "~/cli/commands/dashboard";
import { listCommand } from "~/cli/commands/list";
import { mcpCommand } from "~/cli/commands/mcp";
import {
  artifactsCommand,
  runsCommand,
  sandboxesCommand,
  sessionsCommand,
} from "~/cli/commands/resources";
import { settingsCommand } from "~/cli/commands/settings";
import { startCommand } from "~/cli/commands/start";
import { stopCommand } from "~/cli/commands/stop";
import { tasksCommand } from "~/cli/commands/tasks";
import { triggerCommand } from "~/cli/commands/trigger";
import { watchCommand } from "~/cli/commands/watch";
import { workspacesCommand } from "~/cli/commands/workspaces";
import {
  type CliContext,
  type CliIo,
  createCliContext,
  defaultCliIo,
  type GlobalFlags,
} from "~/cli/context";
import { isActionableError, UsageError } from "~/cli/errors";
import { layout } from "~/layout";
import { setupProviders } from "~/workspace/provider-setup";
import { DEFAULT_SOURCE } from "~/workspace/source";

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous command registry preserves per-command arg types via COMMANDS
type AnyCommand = CommandDefinition<string, any, CommandNeeds>;

const helpCommand = defineCommand({
  group: "core",
  json: false,
  name: "help",
  needs: "none",
  parse: () => ({}),
  run(ctx) {
    ctx.io.print(formatHelp());
  },
  summary: "show this help",
  usage: "help, --help, -h",
});

export const COMMAND_LIST = [
  dashboardCommand,
  listCommand,
  triggerCommand,
  watchCommand,
  helpCommand,
  workspacesCommand,
  tasksCommand,
  runsCommand,
  sessionsCommand,
  artifactsCommand,
  sandboxesCommand,
  startCommand,
  stopCommand,
  mcpCommand,
  settingsCommand,
] as const;

export const COMMANDS = {
  artifacts: artifactsCommand,
  dashboard: dashboardCommand,
  help: helpCommand,
  list: listCommand,
  mcp: mcpCommand,
  runs: runsCommand,
  sandboxes: sandboxesCommand,
  sessions: sessionsCommand,
  settings: settingsCommand,
  start: startCommand,
  stop: stopCommand,
  tasks: tasksCommand,
  trigger: triggerCommand,
  watch: watchCommand,
  workspaces: workspacesCommand,
} as const;

export type CommandName = keyof typeof COMMANDS;

type ArgsOf<C extends CommandName> = GlobalFlags & {
  readonly command: C;
} & ReturnType<(typeof COMMANDS)[C]["parse"]>;

export type ParsedArgs = {
  readonly [C in CommandName]: ArgsOf<C>;
}[CommandName];

const GROUP_HEADERS: readonly {
  readonly group: CommandGroup;
  readonly heading: string;
}[] = [
  { group: "core", heading: "Core:" },
  {
    group: "resources",
    heading:
      "Resources (--workspace <id|dir> to filter; --all for every workspace):",
  },
  { group: "system", heading: "System:" },
];

const GLOBAL_FLAGS_HELP: readonly UsageEntry[] = [
  {
    command: "--source <path>",
    summary: "authoring folder or module (default: ./.foundry/marbles)",
  },
  {
    command: "--json",
    summary: "print structured JSON output instead of formatted text",
  },
  { command: "--help, -h", summary: "show this help" },
];

const RUNTIME_NOTES = `One Marbles process per machine hosts every attached workspace, all in one engine
process it replaces on a source edit, and keeps their triggers running after the dashboard
closes; marbles, start, and trigger start it when none runs. Everything lives under the
Foundry root ($FOUNDRY_ROOT, else ~/.foundry): every workspace's record, tasks, agent
sessions, runs, providers and the rest in marbles/marbles.db; each workspace (the project
above .foundry/marbles) gets marbles/<id>/ for its run output and worktrees; artifact files
are under artifacts/.`;

function usageEntriesOf(command: AnyCommand): readonly UsageEntry[] {
  return typeof command.usage === "string"
    ? [{ command: command.usage, summary: command.summary }]
    : command.usage;
}

function formatEntry(entry: UsageEntry, width: number): string {
  const indent = " ".repeat(width + 2);
  const lines = entry.summary.split("\n");
  if (entry.command.length > width - 2) {
    return [
      `  ${entry.command}`,
      ...lines.map((line) => `${indent}${line}`),
    ].join("\n");
  }
  const [first, ...rest] = lines;
  return [
    `  ${entry.command.padEnd(width)}${first ?? ""}`,
    ...rest.map((line) => `${indent}${line}`),
  ].join("\n");
}

export function formatHelp(
  commands: readonly AnyCommand[] = COMMAND_LIST
): string {
  const sections: string[] = ["marbles — programmable workspace automation"];
  for (const { group, heading } of GROUP_HEADERS) {
    const entries = commands
      .filter((command) => command.group === group)
      .flatMap(usageEntriesOf);
    if (entries.length > 0) {
      sections.push(
        [heading, ...entries.map((entry) => formatEntry(entry, 28))].join("\n")
      );
    }
  }
  sections.push(
    [
      "Flags:",
      ...GLOBAL_FLAGS_HELP.map((entry) => formatEntry(entry, 22)),
    ].join("\n")
  );
  sections.push(RUNTIME_NOTES);
  for (const command of commands) {
    if (command.details !== undefined) {
      sections.push(command.details);
    }
  }
  return sections.join("\n\n");
}

const MOVED: Readonly<Record<string, string>> = {
  attach: "marbles start",
  daemon: "marbles start or marbles stop",
  detach: "marbles stop --workspace",
  enqueue: "marbles trigger <name> --async",
  roll: "marbles trigger <name>",
  run: "marbles trigger <name>",
  status: "marbles workspaces",
  theme: "marbles settings",
};

function isCommandName(name: string): name is CommandName {
  return (
    Object.hasOwn(COMMANDS, name) &&
    COMMANDS[name as CommandName].hidden !== true
  );
}

function knownCommand(name: string): CommandName {
  if (isCommandName(name)) {
    return name;
  }
  const moved = Object.hasOwn(MOVED, name) ? MOVED[name] : undefined;
  throw new UsageError(
    `unknown command "${name}"${moved === undefined ? "" : `; ${name} is now ${moved}`}`
  );
}

function scopeOf(
  command: string | undefined,
  positional: readonly string[]
): string {
  if (command === undefined) {
    return "";
  }
  const [action] = positional;
  return command === "tasks" && action !== undefined && !action.startsWith("--")
    ? `tasks ${action}: `
    : `${command}: `;
}

function sourceValue(value: string | undefined): string {
  if (value === undefined) {
    throw new UsageError("--source takes a value");
  }
  if (isFlag(value)) {
    throw new UsageError(`--source takes a value, not the flag ${value}`);
  }
  return value;
}

interface ScannedArgs {
  readonly command: string | undefined;
  readonly flags: GlobalFlags;
  readonly help: boolean;
  readonly positional: readonly string[];
}

function consumeCommandFlag(
  word: string,
  command: string | undefined,
  positional: string[],
  words: ArrayIterator<string>
): void {
  const scope = scopeOf(command, positional);
  const own =
    command !== undefined && isCommandName(command)
      ? COMMANDS[command].flags
      : undefined;
  if (own?.switches?.has(word)) {
    positional.push(word);
    return;
  }
  if (own?.options?.has(word)) {
    const { value } = words.next();
    if (value === undefined) {
      throw new UsageError(`${scope}${word} takes a value`);
    }
    positional.push(word, value);
    return;
  }
  if (command !== undefined && Object.hasOwn(MOVED, command)) {
    knownCommand(command);
  }
  throw new UsageError(`${scope}unknown option ${word}`);
}

function scanArgv(argv: readonly string[]): ScannedArgs {
  let command: string | undefined;
  const positional: string[] = [];
  let config: string | undefined;
  let help = false;
  let json = false;

  const words = argv.values();
  for (const word of words) {
    if (!isFlag(word)) {
      if (command === undefined) {
        command = word;
      } else {
        positional.push(word);
      }
      continue;
    }
    if (word === "--help" || word === "-h") {
      help = true;
    } else if (word === "--json") {
      json = true;
    } else if (word === "--source") {
      config = sourceValue(words.next().value);
    } else {
      consumeCommandFlag(word, command, positional, words);
    }
  }

  const { artifacts, state } = layout();
  const flags: GlobalFlags = {
    artifacts,
    config: config ?? DEFAULT_SOURCE,
    directory: process.cwd(),
    json,
    ...(config === undefined ? {} : { sourceExplicit: true }),
    state,
  };
  return { command, flags, help, positional };
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const { command, flags, help, positional } = scanArgv(argv);
  if (help) {
    return { ...flags, command: "help" };
  }
  const name = command === undefined ? "dashboard" : knownCommand(command);
  const definition: AnyCommand = COMMANDS[name];
  if (flags.json && definition.json === false) {
    throw new UsageError(`${name} does not support --json`);
  }
  const parsed = definition.parse(positional, flags);
  return { ...flags, ...parsed, command: name } as ParsedArgs;
}

async function askYes(question: string): Promise<boolean> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await prompt.question(question)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    prompt.close();
  }
}

async function dispatch(
  definition: AnyCommand,
  ctx: CliContext,
  args: ParsedArgs
): Promise<void> {
  if (ctx.interactive && definition.interactive !== undefined) {
    await definition.interactive(ctx, args);
    return;
  }
  switch (definition.needs) {
    case "none":
      await definition.run(ctx, args);
      return;
    case "workspace":
      await definition.run({ ...ctx, workspace: ctx.findWorkspace() }, args);
      return;
    case "triggers": {
      const { opened, triggers } = await ctx.openTriggers();
      await definition.run({ ...ctx, opened, triggers }, args);
      return;
    }
    case "daemon":
      await ctx.attachWorkspace(async (hosted) => {
        await definition.run({ ...ctx, hosted }, args);
      });
      return;
    case "tasks":
      await ctx.openTasks(async (tasks) => {
        await definition.run({ ...ctx, tasks }, args);
      });
      return;
    default:
      throw new Error(
        `no handler for ${String(definition.needs satisfies never)}`
      );
  }
}

export interface RunCliOptions {
  readonly interactive?: boolean;
  readonly io?: CliIo;
}

export async function runCli(
  argv: readonly string[],
  entry?: string,
  options: RunCliOptions = {}
): Promise<void> {
  const io = options.io ?? defaultCliIo();
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) {
      throw error;
    }
    io.stderr(`${error.message}\n\n${formatHelp()}\n`);
    process.exitCode = 1;
    return;
  }
  const ctx = createCliContext({
    argv,
    ...(entry === undefined ? {} : { entry }),
    flags: args,
    ...(options.interactive === undefined
      ? {}
      : { interactive: options.interactive }),
    io,
  });
  const definition: AnyCommand = COMMANDS[args.command];
  try {
    if (ctx.interactive && !args.json && definition.checkProviders) {
      const { workspace } = ctx.findWorkspace();
      await setupProviders({
        confirm: askYes,
        print: ctx.io.print,
        state: args.state,
        workspace: {
          dir: workspace.dir,
          id: workspace.id,
          root: workspace.root,
        },
      });
    }
    await dispatch(definition, ctx, args);
  } catch (error) {
    if (!isActionableError(error)) {
      throw error;
    }
    io.stderr(`marbles: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    await disposeDefaultRuntime().catch((error: unknown) => {
      io.stderr(`marbles: ${String(error)}\n`);
    });
  }
}
