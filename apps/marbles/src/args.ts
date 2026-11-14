import type {
  JsonObject,
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
import { layout } from "~/layout";
import type { TaskCommand } from "~/model/tasks";
import type { HostOptions } from "~/workspace/open";
import { DEFAULT_SOURCE } from "~/workspace/source";
import type { StarterId } from "~/workspace/templates";
import { DEFAULT_STARTER, STARTERS } from "~/workspace/templates";

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

interface Positionals {
  readonly attach: NoPositionals;
  readonly daemon: NoPositionals;
  readonly detach: NoPositionals;
  readonly help: NoPositionals;
  readonly init: { readonly starter: StarterId };
  readonly list: NoPositionals;
  readonly mcp: NoPositionals;
  readonly roll: { readonly name: string };
  readonly run: NoPositionals;
  readonly sessions: NoPositionals;
  readonly status: NoPositionals;
  readonly stop: NoPositionals;
  readonly tasks: { readonly json: boolean; readonly task: TaskCommand };
  readonly watch: { readonly runId: string };
}

export type Command = keyof Positionals;

type Parsed<C extends Command> = { readonly command: C } & Positionals[C];

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
  attach: none("attach"),
  daemon: none("daemon"),
  detach: none("detach"),
  // Whatever follows help is ignored: help is asked for, not run.
  help: () => ({ command: "help" }),
  init: ([starter = DEFAULT_STARTER, ...rest]) => {
    if (rest.length > 0 || !isStarter(starter)) {
      throw new UsageError(`init takes one starter: ${STARTER_LIST}`);
    }
    return { command: "init", starter };
  },
  list: none("list"),
  mcp: none("mcp"),
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
  stop: none("stop"),
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
  "--metadata",
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

/** `text` parsed as JSON; `flag` names it in the error. */
function parsedJson(flag: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(
      `${flag} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

/**
 * `--metadata <json>` as the object create stores, or update sets over the
 * stored keys; the batch schema checks it.
 */
function metadataOf(line: TaskLine): JsonObject | undefined {
  const text = line.value("--metadata");
  return text === undefined
    ? undefined
    : (parsedJson("--metadata", text) as JsonObject);
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

const CREATED = "task";

const TASK_ACTIONS = {
  cancel: setStatus("cancelled"),
  change: (line: TaskLine, inputJson: string | undefined): TaskCommand => {
    if (inputJson === undefined) {
      throw new UsageError(
        "tasks change takes --input '{\"operations\":[...]}'"
      );
    }
    return {
      change: checked(taskChangeSchema, parsedJson("--input", inputJson), line),
      kind: "change",
    };
  },
  complete: setStatus("completed"),
  create: (line: TaskLine): TaskCommand => {
    const title = line.word("a title");
    const description = line.value("--description");
    const parent = line.value("--parent");
    const tags = line.values("--tag");
    const metadata = metadataOf(line);
    return change(line, [
      {
        input: {
          title,
          ...(description === undefined ? {} : { description }),
          ...(metadata === undefined ? {} : { metadata }),
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
    const metadata = metadataOf(line);
    if (
      title === undefined &&
      description === undefined &&
      tags === undefined &&
      metadata === undefined
    ) {
      throw new UsageError(
        "tasks update takes --title, --description, --metadata, --tag, or --clear-tags"
      );
    }
    return change(line, [
      {
        kind: "task.update",
        patch: {
          ...(title === undefined ? {} : { title }),
          ...(description === undefined ? {} : { description }),
          ...(metadata === undefined ? {} : { metadata }),
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

export interface Flags extends HostOptions {
  readonly inputJson: string | undefined;
}

export type ArgsOf<C extends Command> = Flags & Parsed<C>;

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

/** The flags on a command line, and the words that are not flags, in order. */
function parseFlags(argv: readonly string[]): {
  readonly flags: Flags;
  readonly positional: readonly string[];
} {
  const positional: string[] = [];
  let harness = false;
  const values: Partial<Record<(typeof VALUE_FLAGS)[ValueFlag], string>> = {};
  let dry = false;

  const argumentsIterator = argv.values();
  for (const arg of argumentsIterator) {
    // `--dry` was the flag's first spelling. Left unrecognised it would parse
    // as a positional and the command would run for real.
    if (arg === "--dry-run" || arg === "--dry") {
      dry = true;
    } else if (arg === "--harness") {
      harness = true;
      argumentsIterator.next();
    } else if (isValueFlag(arg)) {
      const { value } = argumentsIterator.next();
      if (value !== undefined) {
        values[VALUE_FLAGS[arg]] = value;
      }
    } else {
      positional.push(arg);
    }
  }

  const { artifacts, state } = layout({
    artifacts: values.artifacts,
    state: values.state,
  });
  const flags = {
    artifacts,
    config: values.config ?? DEFAULT_SOURCE,
    dry,
    inputJson: values.inputJson,
    state,
  };
  if (harness && !(argv.includes("--help") || argv.includes("-h"))) {
    throw new UsageError(
      "--harness was removed: Marbles uses the providers you configured, in their order"
    );
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
