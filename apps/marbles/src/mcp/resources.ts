import { readyQuerySchema, taskQuerySchema } from "@foundry/tasks";
import { z } from "zod";
import { isHostingUnavailable, ToolRefusal } from "~/mcp/errors";
import type {
  RunInfo,
  RunListQuery,
  WorkspaceConfig,
  WorkspaceConnection,
  WorkspaceSummary,
} from "~/model/connection";
import type {
  TaskCommand,
  TaskCommandKind,
  TaskCommandResult,
} from "~/model/tasks";

type TaskCommandRunner = <K extends TaskCommandKind>(
  command: TaskCommand<K>,
  workspace: string | undefined
) => Promise<TaskCommandResult<K>>;

export interface McpServerOptions {
  hosted<T>(
    id: string,
    work: (workspace: WorkspaceConnection) => Promise<T>
  ): Promise<T>;
  readonly id?: string;
  readonly tasks: TaskCommandRunner;
  workspaces(): Promise<readonly WorkspaceSummary[]>;
}

type Item = Record<string, unknown>;

const LIST_RESOURCES = ["workspaces", "definitions", "tasks", "runs"] as const;
type ListResource = (typeof LIST_RESOURCES)[number];

const GET_RESOURCES = ["workspace", "definition", "task", "run"] as const;
type GetResource = (typeof GET_RESOURCES)[number];

const RUN_STATUSES = [
  "queued",
  "running",
  "suspended",
  "completed",
  "failed",
  "cancelled",
] as const;

const TASK_FIELDS = [
  "id",
  "title",
  "description",
  "status",
  "parentId",
  "tags",
  "metadata",
  "createdAt",
  "updatedAt",
  "settledAt",
] as const;
const TASK_RELATIONS = ["dependsOn", "dependents"] as const;
const SUMMARY_FIELDS = ["id", "root", "source", "state", "error", "pid"];
const CONFIG_FIELDS = [
  "definitions",
  "agents",
  "schedules",
  "monitors",
  "observers",
] as const;
const DEFINITION_FIELDS = [
  "name",
  "kind",
  "description",
  "inputSchema",
  "input",
  "origin",
];
const RUN_FIELDS = [
  "id",
  "kind",
  "name",
  "status",
  "queuedAt",
  "startedAt",
  "endedAt",
  "error",
  "output",
  "text",
  "session",
];

interface ListSpec {
  readonly defaults: readonly string[];
  readonly depth: boolean;
  readonly fields: readonly string[];
  readonly filters: readonly string[];
  readonly identity: string;
  readonly workspace: boolean;
}

const LISTS: Readonly<Record<ListResource, ListSpec>> = {
  definitions: {
    defaults: ["name", "kind", "description"],
    depth: false,
    fields: DEFINITION_FIELDS,
    filters: ["kind", "name"],
    identity: "name",
    workspace: true,
  },
  runs: {
    defaults: ["id", "kind", "name", "status", "queuedAt"],
    depth: false,
    fields: [
      "id",
      "kind",
      "name",
      "status",
      "queuedAt",
      "startedAt",
      "endedAt",
      "error",
      "session",
    ],
    filters: ["status", "name", "kind"],
    identity: "id",
    workspace: true,
  },
  tasks: {
    defaults: ["id", "title", "status", "parentId", "tags", "updatedAt"],
    depth: true,
    fields: TASK_FIELDS,
    filters: ["status", "parentId", "tags", "ready"],
    identity: "id",
    workspace: true,
  },
  workspaces: {
    defaults: ["id", "root", "source", "state", "error"],
    depth: false,
    fields: SUMMARY_FIELDS,
    filters: [],
    identity: "id",
    workspace: false,
  },
};

interface GetSpec {
  readonly defaults: readonly string[];
  readonly depth: boolean;
  readonly fields: readonly string[];
  readonly identity: string;
}

const GETS: Readonly<Record<GetResource, GetSpec>> = {
  definition: {
    defaults: DEFINITION_FIELDS,
    depth: false,
    fields: DEFINITION_FIELDS,
    identity: "name",
  },
  run: {
    defaults: RUN_FIELDS,
    depth: false,
    fields: RUN_FIELDS,
    identity: "id",
  },
  task: {
    defaults: [...TASK_FIELDS],
    depth: true,
    fields: [...TASK_FIELDS, ...TASK_RELATIONS],
    identity: "id",
  },
  workspace: {
    defaults: [...SUMMARY_FIELDS, ...CONFIG_FIELDS],
    depth: false,
    fields: [...SUMMARY_FIELDS, ...CONFIG_FIELDS],
    identity: "id",
  },
};

const WORKSPACE_DESCRIPTION =
  "A workspace id from list (resource: workspaces); defaults to the active workspace when started inside one.";

export const WORKSPACE_INPUT = z
  .string()
  .min(1)
  .optional()
  .describe(WORKSPACE_DESCRIPTION);

const FIELDS_INPUT = z
  .array(z.string().min(1))
  .optional()
  .describe(
    "Top-level fields to return; the identity field (id, or name for definitions) is always kept. Omit for the resource's default fields."
  );

export const listInput = z.strictObject({
  cursor: z
    .int()
    .min(0)
    .optional()
    .describe("Where the page starts: the nextCursor of the previous page."),
  depth: z
    .int()
    .min(0)
    .optional()
    .describe("tasks only: levels of subtasks to expand under each task."),
  fields: FIELDS_INPUT.describe(
    "Top-level fields per item. workspaces: id, root, source, state, error (default), pid. definitions: name, kind, description (default), inputSchema, input, origin. tasks: id, title, status, parentId, tags, updatedAt (default), description, metadata, createdAt, settledAt. runs: id, kind, name, status, queuedAt (default), startedAt, endedAt, error, session. The identity field (id, or name for definitions) is always kept."
  ),
  filter: z
    .looseObject({
      kind: z
        .string()
        .optional()
        .describe(
          'definitions: "workflow" or "step". runs: "agent" or "workflow".'
        ),
      name: z
        .string()
        .optional()
        .describe("definitions and runs: an exact definition or agent name."),
      parentId: z
        .string()
        .nullable()
        .optional()
        .describe("tasks: a parent task id, or null for root tasks."),
      ready: z
        .boolean()
        .optional()
        .describe(
          "tasks: true lists open tasks nothing holds back (what is next); refuses status, parentId and depth."
        ),
      status: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe(
          "tasks: one of open, active, completed, cancelled. runs: one or more of queued, running, suspended, completed, failed, cancelled."
        ),
      tags: z
        .looseObject({
          all: z.array(z.string()).optional(),
          any: z.array(z.string()).optional(),
        })
        .optional()
        .describe(
          "tasks: all lists tasks carrying every tag given, any those carrying at least one."
        ),
    })
    .optional()
    .describe(
      "Resource-specific filters. workspaces: none. definitions: kind, name. tasks: status, parentId, tags, ready. runs: status, name, kind."
    ),
  limit: z.int().min(1).optional().describe("The most items to return."),
  resource: z.enum(LIST_RESOURCES).describe("What to list."),
  workspace: WORKSPACE_INPUT.describe(
    `${WORKSPACE_DESCRIPTION} Refused for resource workspaces.`
  ),
});
type ListInput = z.infer<typeof listInput>;

export const getInput = z.strictObject({
  depth: z
    .int()
    .min(0)
    .optional()
    .describe("task only: levels of subtasks to expand."),
  fields: FIELDS_INPUT.describe(
    "Top-level fields to return; every field but the opt-in ones when omitted. workspace: id, root, source, state, error, pid, and, when the workspace is hosted and ready, definitions, agents, schedules, monitors, observers. definition: name, kind, description, inputSchema, input, origin. task: id, title, description, status, parentId, tags, metadata, createdAt, updatedAt, settledAt, and the opt-in dependsOn and dependents. run: id, kind, name, status, queuedAt, startedAt, endedAt, error, output, text, session. The identity field (id, or name for a definition) is always kept."
  ),
  id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The workspace id (this server's when omitted), definition name, task id, or run id."
    ),
  resource: z.enum(GET_RESOURCES).describe("What to read."),
  workspace: WORKSPACE_INPUT.describe(
    `${WORKSPACE_DESCRIPTION} Refused for resource workspace; pass the workspace's id as id instead.`
  ),
});
type GetInput = z.infer<typeof getInput>;

const pageQuery = (input: ListInput) => ({
  ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  ...(input.limit === undefined ? {} : { limit: input.limit }),
});

type PageQuery = ReturnType<typeof pageQuery>;

type ListRequest =
  | {
      readonly fields: readonly string[];
      readonly page: PageQuery;
      readonly resource: "workspaces";
    }
  | {
      readonly fields: readonly string[];
      readonly filter: {
        readonly kind?: "step" | "workflow";
        readonly name?: string;
      };
      readonly page: PageQuery;
      readonly resource: "definitions";
      readonly workspace?: string;
    }
  | {
      readonly command: TaskCommand<"list" | "ready">;
      readonly fields: readonly string[];
      readonly resource: "tasks";
      readonly workspace?: string;
    }
  | {
      readonly fields: readonly string[];
      readonly query: RunListQuery;
      readonly resource: "runs";
      readonly workspace?: string;
    };

type GetRequest =
  | {
      readonly config: boolean;
      readonly fields: readonly string[];
      readonly id: string;
      readonly explicit: boolean;
      readonly resource: "workspace";
    }
  | {
      readonly fields: readonly string[];
      readonly id: string;
      readonly resource: "definition" | "run";
      readonly workspace?: string;
    }
  | {
      readonly depth?: number;
      readonly fields: readonly string[];
      readonly id: string;
      readonly relations: boolean;
      readonly resource: "task";
      readonly workspace?: string;
    };

const list = (values: readonly string[]): string =>
  values.map((value) => `"${value}"`).join(", ");

function chosenFields(
  what: string,
  spec: {
    readonly defaults: readonly string[];
    readonly fields: readonly string[];
    readonly identity: string;
  },
  fields: readonly string[] | undefined
): readonly string[] {
  if (fields === undefined) {
    return spec.defaults;
  }
  const unknown = fields.filter((field) => !spec.fields.includes(field));
  if (unknown.length > 0) {
    throw new ToolRefusal(
      "invalid_fields",
      `${what} has no field ${list(unknown)}; its fields are ${list(spec.fields)}`
    );
  }
  return [spec.identity, ...fields.filter((field) => field !== spec.identity)];
}

function refuseArgument(message: string): never {
  throw new ToolRefusal("invalid_argument", message);
}

function filterValue<T>(what: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ToolRefusal(
      "invalid_filter",
      `${what}: ${z.prettifyError(parsed.error)}`
    );
  }
  return parsed.data;
}

const definitionFilter = z.strictObject({
  kind: z.enum(["workflow", "step"]).optional(),
  name: z.string().optional(),
});

const runStatus = z.enum(RUN_STATUSES);
const runFilter = z.strictObject({
  kind: z.enum(["agent", "workflow"]).optional(),
  name: z.string().optional(),
  status: z.union([runStatus, z.array(runStatus).min(1)]).optional(),
});

function taskQuery(
  input: ListInput,
  filter: Readonly<Record<string, unknown>>
): TaskCommand<"list" | "ready"> {
  const { ready, ...rest } = filter;
  if (ready === undefined) {
    return {
      kind: "list",
      query: filterValue("list tasks filter", taskQuerySchema, {
        ...rest,
        ...pageQuery(input),
        ...(input.depth === undefined ? {} : { depth: input.depth }),
      }),
    };
  }
  if (ready !== true) {
    throw new ToolRefusal(
      "invalid_filter",
      "filter.ready takes only true; omit it to list tasks whatever holds them back"
    );
  }
  const refused = ["status", "parentId"].filter((key) => key in rest);
  if (refused.length > 0) {
    throw new ToolRefusal(
      "invalid_filter",
      `filter.ready lists open tasks nothing holds back, so it takes no ${list(refused)}; ready takes tags alone`
    );
  }
  if (input.depth !== undefined) {
    refuseArgument(
      "filter.ready lists tasks without subtasks; it takes no depth"
    );
  }
  return {
    kind: "ready",
    query: filterValue("list tasks filter", readyQuerySchema, {
      ...rest,
      ...pageQuery(input),
    }),
  };
}

function narrowList(input: ListInput): ListRequest {
  const { resource } = input;
  const spec = LISTS[resource];
  const what = `list ${resource}`;
  if (input.workspace !== undefined && !spec.workspace) {
    refuseArgument(
      `${what} reads every workspace and takes no workspace; get (resource: workspace) reads one`
    );
  }
  if (input.depth !== undefined && !spec.depth) {
    refuseArgument(`${what} takes no depth; only tasks expand subtasks`);
  }
  const filter: Readonly<Record<string, unknown>> = input.filter ?? {};
  const strange = Object.keys(filter).filter(
    (key) => !spec.filters.includes(key)
  );
  if (strange.length > 0) {
    throw new ToolRefusal(
      "invalid_filter",
      spec.filters.length === 0
        ? `${what} takes no filter; got ${list(strange)}`
        : `${what} takes filter keys ${list(spec.filters)}; got ${list(strange)}`
    );
  }
  const fields = chosenFields(
    `a listed ${resource.slice(0, -1)}`,
    spec,
    input.fields
  );
  const scoped =
    input.workspace === undefined ? {} : { workspace: input.workspace };
  switch (resource) {
    case "workspaces":
      return { fields, page: pageQuery(input), resource };
    case "definitions":
      return {
        fields,
        filter: filterValue(`${what} filter`, definitionFilter, filter),
        page: pageQuery(input),
        resource,
        ...scoped,
      };
    case "tasks":
      return {
        command: taskQuery(input, filter),
        fields,
        resource,
        ...scoped,
      };
    case "runs": {
      const { status, ...rest } = filterValue(
        `${what} filter`,
        runFilter,
        filter
      );
      return {
        fields,
        query: {
          ...rest,
          ...pageQuery(input),
          ...(status === undefined
            ? {}
            : { status: typeof status === "string" ? [status] : status }),
        },
        resource,
        ...scoped,
      };
    }
    default:
      return resource satisfies never;
  }
}

export function requireWorkspaceId(
  id: string | undefined,
  own: string | undefined
): string {
  const resolved = id ?? own;
  if (resolved === undefined) {
    refuseArgument(
      "workspace is required when no default workspace is active; list (resource: workspaces) names them"
    );
  }
  return resolved;
}

function narrowGet(input: GetInput, own: string | undefined): GetRequest {
  const { resource } = input;
  const spec = GETS[resource];
  const what = `get ${resource}`;
  if (input.depth !== undefined && !spec.depth) {
    refuseArgument(`${what} takes no depth; only a task expands subtasks`);
  }
  const fields = chosenFields(`a ${resource}`, spec, input.fields);
  if (resource === "workspace") {
    if (input.workspace !== undefined) {
      refuseArgument(`${what} takes the workspace's id as id, not workspace`);
    }
    const id = input.id ?? own;
    if (id === undefined) {
      refuseArgument(
        `${what} needs an id when no default workspace is active; list (resource: workspaces) names them`
      );
    }
    return {
      config: fields.some((field) =>
        (CONFIG_FIELDS as readonly string[]).includes(field)
      ),
      explicit: input.fields !== undefined,
      fields,
      id,
      resource,
    };
  }
  if (input.id === undefined) {
    refuseArgument(
      `${what} needs an id: the ${resource === "definition" ? "definition's name" : `${resource}'s id`}`
    );
  }
  const scoped =
    input.workspace === undefined ? {} : { workspace: input.workspace };
  if (resource === "task") {
    return {
      ...(input.depth === undefined ? {} : { depth: input.depth }),
      fields,
      id: input.id,
      relations: fields.some((field) =>
        (TASK_RELATIONS as readonly string[]).includes(field)
      ),
      resource,
      ...scoped,
    };
  }
  return { fields, id: input.id, resource, ...scoped };
}

function project(
  value: object,
  fields: readonly string[],
  nested?: string
): Item {
  const source = value as Item;
  const item: Item = {};
  for (const field of fields) {
    if (source[field] !== undefined) {
      item[field] = source[field];
    }
  }
  const children = nested === undefined ? undefined : source[nested];
  if (nested !== undefined && Array.isArray(children)) {
    item[nested] = children.map((child: object) =>
      project(child, fields, nested)
    );
  }
  return item;
}

function paged(
  all: readonly object[],
  fields: readonly string[],
  { cursor = 0, limit }: PageQuery
) {
  const end = limit === undefined ? all.length : cursor + limit;
  return {
    items: all.slice(cursor, end).map((value) => project(value, fields)),
    ...(end < all.length ? { nextCursor: end } : {}),
    total: all.length,
  };
}

function summaryItem({ config, ...summary }: WorkspaceSummary): Item {
  return { ...summary, source: config };
}

export function runItem({ runId, ...run }: RunInfo): Item {
  return { id: runId, ...run };
}

export interface Resources {
  get(input: GetInput): Promise<Record<string, unknown>>;
  list(input: ListInput): Promise<Record<string, unknown>>;
}

function outdatedDaemon(method: string, cause: Error): ToolRefusal {
  return new ToolRefusal(
    "daemon_outdated",
    `the running Marbles process predates the "${method}" method this MCP server needs; restart it with \`marbles stop\` and then \`marbles start\``,
    { cause }
  );
}

export function resources(options: McpServerOptions): Resources {
  const { workspaces } = options;
  const tasks: TaskCommandRunner = (command, workspace) =>
    options.tasks(command, requireWorkspaceId(workspace, options.id));
  const on = <T>(
    id: string | undefined,
    work: (workspace: WorkspaceConnection) => Promise<T>
  ): Promise<T> => options.hosted(requireWorkspaceId(id, options.id), work);

  const listed = async (request: ListRequest) => {
    switch (request.resource) {
      case "workspaces":
        return paged(
          (await workspaces()).map(summaryItem),
          request.fields,
          request.page
        );
      case "definitions": {
        const { kind, name } = request.filter;
        const config = await on(request.workspace, (workspace) =>
          workspace.describe()
        );
        return paged(
          config.definitions.filter(
            (entry) =>
              (kind === undefined || entry.kind === kind) &&
              (name === undefined || entry.name === name)
          ),
          request.fields,
          request.page
        );
      }
      case "tasks": {
        const page = await tasks(request.command, request.workspace);
        return {
          ...page,
          items: page.items.map((task) =>
            project(task, request.fields, "subtasks")
          ),
        };
      }
      case "runs": {
        const page = await on(request.workspace, async (workspace) => {
          try {
            return await workspace.listRuns(request.query);
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === 'no workspace method "listRuns"'
            ) {
              throw outdatedDaemon("listRuns", error);
            }
            throw error;
          }
        });
        return {
          ...page,
          items: page.items.map((run) => project(run, request.fields)),
        };
      }
      default:
        return request satisfies never;
    }
  };

  const workspaceItem = async (
    request: Extract<GetRequest, { resource: "workspace" }>
  ): Promise<Item> => {
    const summary = (await workspaces()).find(
      (entry) => entry.id === request.id
    );
    if (summary === undefined) {
      throw new ToolRefusal(
        "not_found",
        `no workspace "${request.id}"; list (resource: workspaces) names them`
      );
    }
    const item = summaryItem(summary);
    const wanted = request.explicit
      ? request.config
      : summary.state === "ready";
    if (!wanted) {
      return item;
    }
    let config: WorkspaceConfig;
    try {
      config = await on(request.id, (workspace) => workspace.describe());
    } catch (error) {
      if (request.explicit || !isHostingUnavailable(error)) {
        throw error;
      }
      return item;
    }
    return { ...item, ...configOf(config) };
  };

  const taskItem = async (
    request: Extract<GetRequest, { resource: "task" }>
  ): Promise<object> => {
    try {
      return await tasks(
        {
          id: request.id,
          kind: request.relations ? "inspect" : "get",
          ...(request.depth === undefined ? {} : { depth: request.depth }),
        },
        request.workspace
      );
    } catch (error) {
      if (
        request.relations &&
        error instanceof Error &&
        error.name === "ZodError"
      ) {
        throw outdatedDaemon("tasks inspect", error);
      }
      throw error;
    }
  };

  const read = async (request: GetRequest): Promise<object> => {
    switch (request.resource) {
      case "workspace":
        return await workspaceItem(request);
      case "definition": {
        const config = await on(request.workspace, (workspace) =>
          workspace.describe()
        );
        const found = config.definitions.find(
          (entry) => entry.name === request.id
        );
        if (found === undefined) {
          throw new ToolRefusal(
            "not_found",
            `no workflow or step named "${request.id}"; list (resource: definitions) names them`
          );
        }
        return found;
      }
      case "task":
        return await taskItem(request);
      case "run":
        return runItem(
          await on(request.workspace, (workspace) =>
            workspace.getRun(request.id)
          )
        );
      default:
        return request satisfies never;
    }
  };

  return {
    async get(input) {
      const request = narrowGet(input, options.id);
      const item = await read(request);
      return {
        item: project(
          item,
          request.fields,
          request.resource === "task" ? "subtasks" : undefined
        ),
      };
    },
    list: (input) => listed(narrowList(input)),
  };
}

function configOf(config: WorkspaceConfig): Item {
  return {
    agents: config.agents,
    definitions: config.definitions,
    monitors: config.monitors,
    observers: config.observers,
    schedules: config.schedules,
  };
}
