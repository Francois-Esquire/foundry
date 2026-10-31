import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  TagQuery,
  TaskOperation,
  TaskStatus,
  TaskToken,
} from "@foundry/tasks";
import {
  depthOptionsSchema,
  readyQuerySchema,
  taskChangeSchema,
  taskQuerySchema,
} from "@foundry/tasks";
import { z } from "zod";
import type { HostOptions } from "~/host";
import { CLI_HARNESS_IDS, isCliHarness } from "~/lib/cli-harnesses";
import type { StarterId } from "~/onboarding/templates";
import { DEFAULT_STARTER, STARTERS } from "~/onboarding/templates";
import { DEFAULT_SOURCE } from "~/source";
import type { TaskCommand } from "~/tasks/command";

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
  readonly list: NoPositionals;
  readonly roll: { readonly name: string };
  readonly run: NoPositionals;
  readonly sessions: NoPositionals;
  readonly status: NoPositionals;
  readonly tasks: { readonly json: boolean; readonly task: TaskCommand };
  readonly watch: { readonly runId: string };
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
  readonly [C in Command]: (
    positionals: readonly string[],
    flags: Flags
  ) => Parsed<C>;
} = {
  // Whatever follows help is ignored: help is asked for, not run.
  help: () => ({ command: "help" }),
  init: ([starter = DEFAULT_STARTER, ...rest]) => {
    if (rest.length > 0 || !isStarter(starter)) {
      throw new UsageError(`init takes one starter: ${STARTER_LIST}`);
    }
    return { command: "init", starter };
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
  tasks: ([action, ...rest], { inputJson }) => {
    const line = new TaskLine(action, rest);
    const json = line.flag("--json");
    if (inputJson !== undefined && action !== "change") {
      throw new UsageError("--input is for tasks change");
    }
    const task = TASK_ACTIONS[line.action](line, inputJson);
    line.done();
    return { command: "tasks", json, task };
  },
  watch: ([runId, ...rest]) => {
    if (!runId || rest.length > 0) {
      throw new UsageError("watch takes one run ID");
    }
    return { command: "watch", runId };
  },
};

/** Options `tasks` reads from its own words; anything else is refused. */
const TASK_SWITCHES = new Set(["--clear-tags", "--json", "--root"]);
const TASK_OPTIONS = new Set([
  "--any-tag",
  "--cursor",
  "--depends-on",
  "--depth",
  "--description",
  "--expect",
  "--limit",
  "--parent",
  "--status",
  "--tag",
  "--title",
]);
const INTEGER = /^-?\d+$/;

/**
 * The words and options after `tasks <action>`. Each action takes what it
 * reads; `done` refuses whatever is left over, so nothing is ignored.
 */
class TaskLine {
  readonly action: TaskActionName;
  readonly #words: string[] = [];
  readonly #options = new Map<string, string[]>();

  constructor(action: string | undefined, argv: readonly string[]) {
    if (action === undefined || !isTaskAction(action)) {
      throw new UsageError(
        `tasks takes an action: ${Object.keys(TASK_ACTIONS).join(", ")}`
      );
    }
    this.action = action;
    const words = argv.values();
    for (const word of words) {
      if (!word.startsWith("--")) {
        this.#words.push(word);
        continue;
      }
      if (TASK_SWITCHES.has(word)) {
        this.#options.set(word, [""]);
        continue;
      }
      if (!TASK_OPTIONS.has(word)) {
        throw new UsageError(`tasks ${action}: unknown option ${word}`);
      }
      const { value } = words.next();
      if (value === undefined) {
        throw new UsageError(`tasks ${action}: ${word} takes a value`);
      }
      this.#options.set(word, [...(this.#options.get(word) ?? []), value]);
    }
  }

  word(what: string): string {
    const word = this.#words.shift();
    if (word === undefined) {
      throw new UsageError(`tasks ${this.action} takes ${what}`);
    }
    return word;
  }

  flag(name: string): boolean {
    return this.#options.delete(name);
  }

  values(name: string): readonly string[] {
    const values = this.#options.get(name) ?? [];
    this.#options.delete(name);
    return values;
  }

  /** The last occurrence wins, as with the global flags. */
  value(name: string): string | undefined {
    return this.values(name).at(-1);
  }

  integer(name: string): number | undefined {
    const value = this.value(name);
    if (value === undefined) {
      return;
    }
    if (!INTEGER.test(value)) {
      throw new UsageError(`tasks ${this.action}: ${name} takes an integer`);
    }
    return Number(value);
  }

  token(): TaskToken {
    const expected = this.value("--expect");
    return expected === undefined ? {} : { expectedUpdatedAt: expected };
  }

  /**
   * `--tag` (every one) and `--any-tag` (at least one) as a tag filter;
   * undefined for neither.
   */
  tagQuery(): TagQuery | undefined {
    const all = this.values("--tag");
    const any = this.values("--any-tag");
    if (all.length === 0 && any.length === 0) {
      return;
    }
    return {
      ...(all.length === 0 ? {} : { all }),
      ...(any.length === 0 ? {} : { any }),
    };
  }

  /** `--root` or `--parent <id>`; null for the root, undefined for neither. */
  parent(): string | null | undefined {
    const root = this.flag("--root");
    const parent = this.value("--parent");
    if (root && parent !== undefined) {
      throw new UsageError(
        `tasks ${this.action} takes --root or --parent, not both`
      );
    }
    return root ? null : parent;
  }

  done(): void {
    const [word] = this.#words;
    if (word !== undefined) {
      throw new UsageError(`tasks ${this.action}: unexpected "${word}"`);
    }
    const [option] = this.#options.keys();
    if (option !== undefined) {
      throw new UsageError(`tasks ${this.action} does not take ${option}`);
    }
  }
}

/** A value checked by the Tasks package's own schema, before anything loads. */
function checked<T>(schema: z.ZodType<T>, value: unknown, line: TaskLine): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new UsageError(
      `tasks ${line.action}: ${z.prettifyError(parsed.error)}`
    );
  }
  return parsed.data;
}

/** Every write is one batch in the task command language. */
function change(
  line: TaskLine,
  operations: readonly TaskOperation[]
): TaskCommand<"change"> {
  return {
    change: checked(taskChangeSchema, { operations }, line),
    kind: "change",
  };
}

function setStatus(status: TaskStatus) {
  return (line: TaskLine): TaskCommand<"change"> =>
    change(line, [
      {
        kind: "task.set_status",
        status,
        task: { id: line.word("a task id") },
        ...line.token(),
      },
    ]);
}

function dependency(kind: "dependency.add" | "dependency.remove") {
  return (line: TaskLine): TaskCommand<"change"> => {
    const task = line.word("a task id and the id it depends on");
    const dependsOn = line.word("a task id and the id it depends on");
    return change(line, [
      { dependsOn: { id: dependsOn }, kind, task: { id: task } },
    ]);
  };
}

/** `--tag`s replace every tag and `--clear-tags` removes them; neither keeps them. */
function updatedTags(line: TaskLine): readonly string[] | undefined {
  const clear = line.flag("--clear-tags");
  const tags = line.values("--tag");
  if (clear && tags.length > 0) {
    throw new UsageError("tasks update takes --tag or --clear-tags, not both");
  }
  if (clear) {
    return [];
  }
  return tags.length === 0 ? undefined : tags;
}

/** The key a CLI-created task has in its batch. */
const CREATED = "task";

/** Each `tasks` action, as the command it runs. */
const TASK_ACTIONS = {
  cancel: setStatus("cancelled"),
  change: (line: TaskLine, inputJson: string | undefined): TaskCommand => {
    if (inputJson === undefined) {
      throw new UsageError(
        "tasks change takes --input '{\"operations\":[...]}'"
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(inputJson);
    } catch (error) {
      throw new UsageError(
        `--input is not JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    return { change: checked(taskChangeSchema, value, line), kind: "change" };
  },
  complete: setStatus("completed"),
  create: (line: TaskLine): TaskCommand => {
    const title = line.word("a title");
    const description = line.value("--description");
    const parent = line.value("--parent");
    const tags = line.values("--tag");
    return change(line, [
      {
        input: {
          title,
          ...(description === undefined ? {} : { description }),
          ...(tags.length === 0 ? {} : { tags }),
        },
        key: CREATED,
        kind: "task.create",
        ...(parent === undefined ? {} : { parent: { id: parent } }),
      },
      ...line.values("--depends-on").map(
        (id): TaskOperation => ({
          dependsOn: { id },
          kind: "dependency.add",
          task: { key: CREATED },
        })
      ),
    ]);
  },
  depend: dependency("dependency.add"),
  deps: (line: TaskLine): TaskCommand => ({
    id: line.word("a task id"),
    kind: "dependencies",
  }),
  get: (line: TaskLine): TaskCommand => ({
    id: line.word("a task id"),
    kind: "get",
    ...checked(depthOptionsSchema, { depth: line.integer("--depth") }, line),
  }),
  list: (line: TaskLine): TaskCommand => ({
    kind: "list",
    query: checked(
      taskQuerySchema,
      {
        cursor: line.integer("--cursor"),
        depth: line.integer("--depth"),
        limit: line.integer("--limit"),
        parentId: line.parent(),
        status: line.value("--status"),
        tags: line.tagQuery(),
      },
      line
    ),
  }),
  move: (line: TaskLine): TaskCommand => {
    const id = line.word("a task id");
    const parent = line.parent();
    if (parent === undefined) {
      throw new UsageError("tasks move takes --parent <id> or --root");
    }
    return change(line, [
      {
        kind: "task.move",
        parent: parent === null ? null : { id: parent },
        task: { id },
        ...line.token(),
      },
    ]);
  },
  ready: (line: TaskLine): TaskCommand => ({
    kind: "ready",
    query: checked(
      readyQuerySchema,
      {
        cursor: line.integer("--cursor"),
        limit: line.integer("--limit"),
        tags: line.tagQuery(),
      },
      line
    ),
  }),
  reopen: setStatus("open"),
  start: setStatus("active"),
  undepend: dependency("dependency.remove"),
  update: (line: TaskLine): TaskCommand => {
    const id = line.word("a task id");
    const title = line.value("--title");
    const description = line.value("--description");
    const tags = updatedTags(line);
    if (
      title === undefined &&
      description === undefined &&
      tags === undefined
    ) {
      throw new UsageError(
        "tasks update takes --title, --description, --tag, or --clear-tags"
      );
    }
    return change(line, [
      {
        kind: "task.update",
        patch: {
          ...(title === undefined ? {} : { title }),
          ...(description === undefined ? {} : { description }),
          ...(tags === undefined ? {} : { tags }),
        },
        task: { id },
        ...line.token(),
      },
    ]);
  },
} satisfies Record<
  string,
  (line: TaskLine, inputJson: string | undefined) => TaskCommand
>;

type TaskActionName = keyof typeof TASK_ACTIONS;

function isTaskAction(name: string): name is TaskActionName {
  return Object.hasOwn(TASK_ACTIONS, name);
}

function isCommand(name: string): name is Command {
  return Object.hasOwn(GRAMMAR, name);
}

/** The flags, which every command reads alike. */
export interface Flags extends HostOptions {
  readonly inputJson: string | undefined;
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
  const unknown = only.find((id) => !isCliHarness(id));
  if (unknown !== undefined) {
    throw new UsageError(
      `unknown harness "${unknown}"; --harness takes ${CLI_HARNESS_IDS.join(" or ")}`
    );
  }
}

/** The flags on a command line, and the words that are not flags, in order. */
function parseFlags(argv: readonly string[]): {
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
  if (!(argv.includes("--help") || argv.includes("-h"))) {
    checkHarnesses(only);
  }
  return { flags, positional };
}

/** Read a command line; throws `UsageError` for one that cannot run. */
export function parseArgs(argv: readonly string[]): Args {
  const { flags, positional } = parseFlags(argv);
  // Help wins over whatever else is on the line, a bad flag included.
  if (argv.includes("--help") || argv.includes("-h")) {
    return { ...flags, ...GRAMMAR.help([], flags) };
  }
  const [command = "run", ...positionals] = positional;
  if (!isCommand(command)) {
    throw new UsageError(`unknown command "${command}"`);
  }
  const parsed = GRAMMAR[command](positionals, flags);
  return { ...flags, ...parsed };
}

/** STDIO host accepts flags only; help keeps the CLI's precedence. */
export function parseMcpArgs(
  argv: readonly string[]
): Flags & { readonly help: boolean } {
  const { flags, positional } = parseFlags(argv);
  const help = argv.includes("--help") || argv.includes("-h");
  if (!help && positional.length > 0) {
    throw new UsageError("MCP accepts flags only");
  }
  return { ...flags, help };
}
