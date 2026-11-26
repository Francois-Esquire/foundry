import type { TagQuery, TaskOperation } from "@foundry/tasks";
import {
  depthOptionsSchema,
  readyQuerySchema,
  TaskError,
  taskChangeSchema,
  taskQuerySchema,
} from "@foundry/tasks";
import { z } from "zod";
import { defineCommand } from "~/cli/command";
import { UsageError } from "~/cli/errors";
import { taskCommandText } from "~/cli/tasks/text";
import type { TaskCommand, TaskCommandResult } from "~/model/tasks";

const TASK_STATUS_SCHEMA = z.enum(["open", "active", "completed", "cancelled"]);

const TASK_SWITCHES = new Set(["--clear-tags", "--ready", "--root"]);
const TASK_OPTIONS = new Set([
  "--depth",
  "--description",
  "--limit",
  "--parent",
  "--status",
  "--tag",
  "--title",
  "--workspace",
]);
const INTEGER = /^-?\d+$/;

const TASKS_DETAILS = `Tasks, the workspace backlog (--tag needs every tag given; on update, --tag replaces the tags):
  tasks [list] [--status <status>] [--ready] [--parent <id> | --root] [--tag <tag>]... [--limit n] [--workspace <ws>]
  tasks get <id> [--depth n] [--workspace <ws>]
  tasks create <title> [--description <text>] [--parent <id>] [--tag <tag>]... [--workspace <ws>]
  tasks update <id> [--status <open|active|completed|cancelled>] [--title <text>] [--description <text>] [--parent <id> | --root] [--tag <tag>... | --clear-tags] [--workspace <ws>]`;

class TaskLine {
  readonly action: TaskActionName;
  readonly #words: string[] = [];
  readonly #options = new Map<string, string[]>();

  constructor(action: TaskActionName, argv: readonly string[]) {
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

  tagQuery(): TagQuery | undefined {
    const all = this.values("--tag");
    return all.length === 0 ? undefined : { all };
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

function listAction(line: TaskLine): TaskCommand {
  const ready = line.flag("--ready");
  if (ready) {
    return {
      kind: "ready",
      query: checked(
        readyQuerySchema,
        {
          limit: line.integer("--limit"),
          tags: line.tagQuery(),
        },
        line
      ),
    };
  }
  return {
    kind: "list",
    query: checked(
      taskQuerySchema,
      {
        depth: line.integer("--depth"),
        limit: line.integer("--limit"),
        parentId: line.parent(),
        status: line.value("--status"),
        tags: line.tagQuery(),
      },
      line
    ),
  };
}

function updateAction(line: TaskLine): TaskCommand {
  const id = line.word("a task id");
  const title = line.value("--title");
  const description = line.value("--description");
  const tags = updatedTags(line);
  const rawStatus = line.value("--status");
  const parent = line.parent();
  const operations: TaskOperation[] = [];
  if (title !== undefined || description !== undefined || tags !== undefined) {
    operations.push({
      kind: "task.update",
      patch: {
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
        ...(tags === undefined ? {} : { tags }),
      },
      task: { id },
    });
  }
  if (rawStatus !== undefined) {
    const status = checked(TASK_STATUS_SCHEMA, rawStatus, line);
    operations.push({
      kind: "task.set_status",
      status,
      task: { id },
    });
  }
  if (parent !== undefined) {
    operations.push({
      kind: "task.move",
      parent: parent === null ? null : { id: parent },
      task: { id },
    });
  }
  if (operations.length === 0) {
    throw new UsageError(
      "tasks update takes --status, --title, --description, --parent, --root, --tag, or --clear-tags"
    );
  }
  return change(line, operations);
}

const CREATED = "task";

const TASK_ACTIONS = {
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
    ]);
  },
  get: (line: TaskLine): TaskCommand => ({
    id: line.word("a task id"),
    kind: "inspect",
    ...checked(depthOptionsSchema, { depth: line.integer("--depth") }, line),
  }),
  list: listAction,
  update: updateAction,
} satisfies Record<string, (line: TaskLine) => TaskCommand>;

type TaskActionName = keyof typeof TASK_ACTIONS;

function isTaskAction(name: string): name is TaskActionName {
  return Object.hasOwn(TASK_ACTIONS, name);
}

export const tasksCommand = defineCommand({
  details: TASKS_DETAILS,
  flags: {
    options: TASK_OPTIONS,
    switches: TASK_SWITCHES,
  },
  group: "resources",
  name: "tasks",
  needs: "none",
  parse(positionals: readonly string[]): {
    readonly task: TaskCommand;
    readonly workspace?: string;
  } {
    const [first] = positionals;
    let action: TaskActionName;
    let rest: readonly string[];
    if (first === undefined || first.startsWith("--")) {
      action = "list";
      rest = positionals;
    } else if (isTaskAction(first)) {
      action = first;
      rest = positionals.slice(1);
    } else {
      throw new UsageError(
        `tasks takes list, get, create, or update (got "${first}")`
      );
    }
    const line = new TaskLine(action, rest);
    const workspace = line.value("--workspace");
    const task = TASK_ACTIONS[action](line);
    line.done();
    return {
      task,
      ...(workspace === undefined ? {} : { workspace }),
    };
  },
  async run(ctx, args) {
    await ctx.openTasks(async (tasks) => {
      let result: TaskCommandResult;
      try {
        result = await tasks(args.task);
      } catch (error) {
        if (!(error instanceof TaskError)) {
          throw error;
        }
        ctx.io.diagnose(`marbles: ${error.message} (${error.code})`);
        process.exitCode = 1;
        return;
      }
      ctx.output(result, (value) => taskCommandText(args.task, value));
    }, args.workspace);
  },
  summary: "workspace tasks: list, get, create, or update",
  usage: "tasks [list | get | create | update] [--workspace <ws>]",
});
