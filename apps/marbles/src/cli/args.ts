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
import type { ResourceKind } from "~/lib/resources";
import { isResourceKind, RESOURCE_KINDS } from "~/lib/resources";
import { isTheme, type ThemeName } from "~/model/settings";
import type { TaskCommand } from "~/model/tasks";
import type { HostOptions } from "~/workspace/open";
import { DEFAULT_SOURCE } from "~/workspace/source";
import type { StarterId } from "~/workspace/templates";
import { DEFAULT_STARTER, STARTERS } from "~/workspace/templates";

export class UsageError extends Error {
  override readonly name = "UsageError";
}

const STARTER_IDS = STARTERS.map((starter) => starter.id);
const STARTER_LIST = `${STARTER_IDS.slice(0, -1).join(", ")}, or ${STARTER_IDS.at(-1)}`;

function isStarter(id: string): id is StarterId {
  return STARTER_IDS.some((starter) => starter === id);
}

type NoPositionals = Record<never, never>;

interface Listing {
  readonly all: boolean;
}

interface Association {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly with: string;
}

interface Positionals {
  readonly artifacts: Listing;
  readonly attach: NoPositionals;
  readonly daemon: NoPositionals;
  readonly detach: NoPositionals;
  readonly help: NoPositionals;
  readonly init: { readonly starter: StarterId };
  readonly list: NoPositionals;
  readonly mcp: NoPositionals;
  readonly relink: Listing;
  readonly roll: { readonly name: string };
  readonly run: NoPositionals;
  readonly runs: Listing;
  readonly sandboxes: Listing;
  readonly sessions: Listing;
  readonly settings:
    | { readonly action: "get" | "themes" }
    | { readonly action: "set"; readonly theme: ThemeName };
  readonly share: Association;
  readonly status: NoPositionals;
  readonly stop: NoPositionals;
  readonly tasks: { readonly json: boolean; readonly task: TaskCommand };
  readonly unshare: Association;
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

const listing =
  <C extends Command>(command: C) =>
  (positionals: readonly string[]): { readonly command: C } & Listing => {
    const all = positionals[0] === "--all";
    if (positionals.length > (all ? 1 : 0)) {
      throw new UsageError(`${command} takes no arguments but --all`);
    }
    return { all, command };
  };

const KIND_LIST = RESOURCE_KINDS.join(", ");

const association =
  <C extends "share" | "unshare">(command: C) =>
  ([kind, id, other, ...rest]: readonly string[]): {
    readonly command: C;
  } & Association => {
    if (
      kind === undefined ||
      id === undefined ||
      other === undefined ||
      rest.length > 0
    ) {
      throw new UsageError(
        `${command} takes a kind (${KIND_LIST}), an id, and another workspace's directory`
      );
    }
    if (!isResourceKind(kind)) {
      throw new UsageError(
        `${command}: no resource kind "${kind}"; one of ${KIND_LIST}`
      );
    }
    return { command, id, kind, with: other };
  };

const GRAMMAR: {
  readonly [C in Command]: (
    positionals: readonly string[],
    flags: Flags
  ) => Parsed<C>;
} = {
  artifacts: listing("artifacts"),
  attach: none("attach"),
  daemon: none("daemon"),
  detach: none("detach"),
  help: () => ({ command: "help" }),
  init: ([starter = DEFAULT_STARTER, ...rest]) => {
    if (rest.length > 0 || !isStarter(starter)) {
      throw new UsageError(`init takes one starter: ${STARTER_LIST}`);
    }
    return { command: "init", starter };
  },
  list: none("list"),
  mcp: none("mcp"),
  relink: listing("relink"),
  roll: ([name, ...rest]) => {
    if (name === undefined || rest.length > 0) {
      throw new UsageError("roll takes one workflow or schedule name");
    }
    return { command: "roll", name };
  },
  run: ([name]) => {
    if (name !== undefined) {
      throw new UsageError(
        `run takes no name. To run one now: marbles roll ${name}`
      );
    }
    return { command: "run" };
  },
  runs: listing("runs"),
  sandboxes: listing("sandboxes"),
  sessions: listing("sessions"),
  settings: ([action, key, value, ...rest], flags) => {
    if (action === "themes" && key === undefined) {
      return { action, command: "settings" };
    }
    if (action === "get" && key === "theme" && value === undefined) {
      return { action, command: "settings" };
    }
    if (
      action === "set" &&
      key === "theme" &&
      value !== undefined &&
      rest.length === 0
    ) {
      if (flags.dry) {
        throw new UsageError(
          "settings set writes settings; it takes no --dry-run"
        );
      }
      if (!isTheme(value)) {
        throw new UsageError(
          `unknown theme "${value}"; run marbles settings themes`
        );
      }
      return { action, command: "settings", theme: value };
    }
    throw new UsageError(
      "settings takes themes, get theme, or set theme <name>"
    );
  },
  share: association("share"),
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
  unshare: association("unshare"),
  watch: ([runId, ...rest]) => {
    if (!runId || rest.length > 0) {
      throw new UsageError("watch takes one run ID");
    }
    return { command: "watch", runId };
  },
};

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

function metadataOf(line: TaskLine): JsonObject | undefined {
  const text = line.value("--metadata");
  return text === undefined
    ? undefined
    : (parsedJson("--metadata", text) as JsonObject);
}

function checked<T>(schema: z.ZodType<T>, value: unknown, line: TaskLine): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new UsageError(
      `tasks ${line.action}: ${z.prettifyError(parsed.error)}`
    );
  }
  return parsed.data;
}

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
  readonly directory: string;
  readonly inputJson: string | undefined;
  readonly recheckProviders?: true;
}

export type ArgsOf<C extends Command> = Flags & Parsed<C>;

export type Args = { readonly [C in Command]: ArgsOf<C> }[Command];

const VALUE_FLAGS = {
  "--input": "inputJson",
  "--source": "config",
} as const;

type ValueFlag = keyof typeof VALUE_FLAGS;

function isValueFlag(arg: string): arg is ValueFlag {
  return Object.hasOwn(VALUE_FLAGS, arg);
}

function isFlag(word: string): boolean {
  return word.startsWith("--") || word === "-h";
}

interface CommandFlags {
  readonly options: ReadonlySet<string>;
  readonly switches: ReadonlySet<string>;
}

const LISTING_FLAGS: CommandFlags = {
  options: new Set(),
  switches: new Set(["--all"]),
};

const COMMAND_FLAGS: Partial<Record<Command, CommandFlags>> = {
  artifacts: LISTING_FLAGS,
  relink: LISTING_FLAGS,
  runs: LISTING_FLAGS,
  sandboxes: LISTING_FLAGS,
  sessions: LISTING_FLAGS,
  tasks: { options: TASK_OPTIONS, switches: TASK_SWITCHES },
};

function flagsOf(command: string | undefined): CommandFlags | undefined {
  return command !== undefined && isCommand(command)
    ? COMMAND_FLAGS[command]
    : undefined;
}

function scopeOf(
  command: string | undefined,
  positional: readonly string[]
): string {
  if (command === undefined) {
    return "";
  }
  const [action] = positional;
  return command === "tasks" && action !== undefined
    ? `tasks ${action}: `
    : `${command}: `;
}

function flagValue(flag: ValueFlag, value: string | undefined): string {
  if (value === undefined) {
    throw new UsageError(`${flag} takes a value`);
  }
  if (isFlag(value)) {
    throw new UsageError(`${flag} takes a value, not the flag ${value}`);
  }
  return value;
}

interface Scanned {
  readonly command: string | undefined;
  readonly flags: Flags;
  readonly help: boolean;
  readonly positional: readonly string[];
}

function parseFlags(argv: readonly string[]): Scanned {
  let command: string | undefined;
  const positional: string[] = [];
  const values: Partial<Record<(typeof VALUE_FLAGS)[ValueFlag], string>> = {};
  let dry = false;
  let help = false;
  let recheckProviders = false;

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
    if (word === "--dry-run") {
      dry = true;
      continue;
    }
    if (word === "--help" || word === "-h") {
      help = true;
      continue;
    }
    if (word === "--recheck-providers") {
      recheckProviders = true;
      continue;
    }
    if (isValueFlag(word)) {
      values[VALUE_FLAGS[word]] = flagValue(word, words.next().value);
      continue;
    }
    const scope = scopeOf(command, positional);
    const own = flagsOf(command);
    if (own?.switches.has(word)) {
      positional.push(word);
      continue;
    }
    if (own?.options.has(word)) {
      const { value } = words.next();
      if (value === undefined) {
        throw new UsageError(`${scope}${word} takes a value`);
      }
      positional.push(word, value);
      continue;
    }
    throw new UsageError(`${scope}unknown option ${word}`);
  }

  const { artifacts, state } = layout();
  const flags: Flags = {
    artifacts,
    config: values.config ?? DEFAULT_SOURCE,
    directory: process.cwd(),
    dry,
    inputJson: values.inputJson,
    ...(recheckProviders ? { recheckProviders: true } : {}),
    state,
  };
  return { command, flags, help, positional };
}

export function parseArgs(argv: readonly string[]): Args {
  const { command = "run", flags, help, positional } = parseFlags(argv);
  if (help) {
    return { ...flags, ...GRAMMAR.help([], flags) };
  }
  if (!isCommand(command)) {
    throw new UsageError(`unknown command "${command}"`);
  }
  if (flags.recheckProviders && (command !== "run" || flags.dry)) {
    throw new UsageError("--recheck-providers requires a live dashboard");
  }
  const parsed = GRAMMAR[command](positional, flags);
  return { ...flags, ...parsed };
}
