import type { TagQuery, TaskOperation, TaskStatus } from "@foundry/tasks";
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

const TASK_SWITCHES = new Set(["--clear-tags", "--root"]);
const TASK_OPTIONS = new Set([
  "--depends-on",
  "--depth",
  "--description",
  "--input",
  "--limit",
  "--parent",
  "--status",
  "--tag",
  "--title",
]);
const INTEGER = /^-?\d+$/;

const TASKS_DETAILS = `Tasks, the workspace backlog (--tag needs every tag given; on update, --tag replaces the tags):
  tasks list [--status <status>] [--parent <id> | --root] [--tag <tag>]... [--depth n] [--limit n]
  tasks ready [--tag <tag>]... [--limit n]
  tasks get <id> [--depth n]
  tasks deps <id>
  tasks create <title> [--description <text>] [--parent <id>] [--depends-on <id>]... [--tag <tag>]...
  tasks update <id> [--title <text>] [--description <text>] [--tag <tag>... | --clear-tags]
  tasks start | complete | cancel | reopen <id>
  tasks move <id> (--parent <id> | --root)
  tasks depend | undepend <id> <dependsOnId>
  tasks change --input '{"operations":[...]}'   one atomic batch of task operations
Tasks are kept with the workspace state. No source runs here: the Marbles process, when it
already hosts this workspace, answers, else this command opens the tasks itself; tasks never
starts the process or hosts the workspace.`;

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
  change: (line: TaskLine): TaskCommand => {
    const inputJson = line.value("--input");
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
      },
    ]);
  },
  ready: (line: TaskLine): TaskCommand => ({
    kind: "ready",
    query: checked(
      readyQuerySchema,
      {
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
      },
    ]);
  },
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
  group: "core",
  name: "tasks",
  needs: "tasks",
  parse([action, ...rest]: readonly string[]): { readonly task: TaskCommand } {
    const line = new TaskLine(action, rest);
    const task = TASK_ACTIONS[line.action](line);
    line.done();
    return { task };
  },
  async run(ctx, args) {
    let result: TaskCommandResult;
    try {
      result = await ctx.tasks(args.task);
    } catch (error) {
      if (!(error instanceof TaskError)) {
        throw error;
      }
      ctx.io.diagnose(`marbles: ${error.message} (${error.code})`);
      process.exitCode = 1;
      return;
    }
    ctx.output(result, (value) => taskCommandText(args.task, value));
  },
  summary: "read or change this workspace's tasks (below)",
  usage: "tasks <action>",
});
