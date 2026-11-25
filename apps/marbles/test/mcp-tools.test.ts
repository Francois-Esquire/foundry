import { Tasks } from "@foundry/tasks";
import { afterEach, expect, it } from "vitest";
import { NotReadyError } from "~/access/workspace";
import type {
  DispatchInfo,
  RunInfo,
  RunListQuery,
  RunPage,
  WorkspaceConfig,
  WorkspaceConnection,
  WorkspaceSummary,
} from "~/model/connection";
import { RemoteError } from "~/process/protocol";
import { runTaskCommand } from "~/workspace/tasks";
import {
  type Connected,
  connectMcp,
  refused,
  structured,
  textOf,
} from "./helpers/mcp-client";

const TOOL_NAMES = [
  "list",
  "get",
  "enqueue_workflow",
  "dispatch_agent",
  "cancel_run",
  "change_tasks",
];

const open: Connected[] = [];

afterEach(async () => {
  for (const connected of open.splice(0)) {
    await connected.close();
  }
});

const SUMMARIES: WorkspaceSummary[] = [
  {
    config: "/own/marbles.ts",
    id: "own",
    pid: 7,
    root: "/own",
    state: "ready",
  },
  { config: null, id: "idle", root: "/idle", state: "stopped" },
  {
    config: "/boot/marbles.ts",
    error: "still loading",
    id: "boot",
    root: "/boot",
    state: "starting",
  },
];

const CONFIG: WorkspaceConfig = {
  agents: [{ id: "helper", model: "m", provider: "p" }],
  definitions: [
    {
      description: "Greets",
      input: { fields: [] },
      inputSchema: { type: "object" },
      kind: "workflow",
      name: "greeting",
      origin: "/own/marbles.ts:3",
    },
    { input: { fields: [] }, kind: "step", name: "greet" },
    { input: { fields: [] }, kind: "step", name: "tidy" },
  ],
  monitors: [],
  observers: [{ name: "triage", source: "tasks" }],
  root: "/own",
  schedules: [],
  source: "/own/marbles.ts",
};

const RUNS: RunPage["items"] = [
  {
    id: "rn-3",
    kind: "agent",
    name: "helper",
    queuedAt: "2026-01-03T00:00:00.000Z",
    session: { id: "s1", instance: "i1" } as never,
    status: "running",
  },
  {
    endedAt: "2026-01-02T00:00:02.000Z",
    id: "rn-2",
    kind: "workflow",
    name: "greeting",
    queuedAt: "2026-01-02T00:00:00.000Z",
    startedAt: "2026-01-02T00:00:01.000Z",
    status: "completed",
  },
];

const RUN: RunInfo = {
  endedAt: "2026-01-02T00:00:02.000Z",
  kind: "workflow",
  name: "greeting",
  output: { greeting: "Hello" },
  queuedAt: "2026-01-02T00:00:00.000Z",
  runId: "rn-2",
  startedAt: "2026-01-02T00:00:01.000Z",
  status: "completed",
};

interface Recorded {
  readonly calls: unknown[][];
  readonly connected: Connected;
  readonly tasks: Tasks;
}

async function serve(
  overrides: Partial<WorkspaceConnection> = {},
  hostedIds: readonly string[] = ["own"]
): Promise<Recorded> {
  const calls: unknown[][] = [];
  const tasks = new Tasks({ clock: () => new Date("2026-10-29T00:00:00Z") });
  const queued = new Map<string, DispatchInfo>();
  const workspace = {
    cancelRun: (runId: string) => {
      calls.push(["cancelRun", runId]);
      return Promise.resolve({ ...RUN, runId, status: "cancelled" as const });
    },
    describe: () => Promise.resolve(CONFIG),
    dispatchAgent: (options: unknown) => {
      calls.push(["dispatchAgent", options]);
      return Promise.resolve({
        kind: "agent" as const,
        name: "helper",
        runId: "rn-agent",
        session: { id: "s9", instance: "i9" } as never,
        status: "queued" as const,
      });
    },
    dispatchWorkflow: (
      name: string,
      input: unknown,
      options?: { readonly key?: string }
    ) => {
      calls.push(["dispatchWorkflow", name, input, options]);
      const key = options?.key ?? `fresh-${String(calls.length)}`;
      const known = queued.get(key) ?? {
        kind: "workflow" as const,
        name,
        runId: `rn-${key}`,
        status: "queued" as const,
      };
      queued.set(key, known);
      return Promise.resolve(known);
    },
    getRun: (runId: string) =>
      runId === RUN.runId
        ? Promise.resolve(RUN)
        : Promise.reject(
            new RemoteError({ message: `no run "${runId}" in this host` })
          ),
    listRuns: (query: RunListQuery = {}) => {
      calls.push(["listRuns", query]);
      return Promise.resolve({ items: RUNS, total: RUNS.length });
    },
    ...overrides,
  } as unknown as WorkspaceConnection;
  const connected = await connectMcp({
    hosted: (id, work) =>
      hostedIds.includes(id)
        ? work(workspace)
        : Promise.reject(
            new NotReadyError(`workspace ${id} is starting; retry once ready`)
          ),
    tasks: (command, id) => {
      calls.push(["tasks", command.kind, id]);
      return runTaskCommand(tasks, command);
    },
    workspaces: () => Promise.resolve(SUMMARIES),
  });
  open.push(connected);
  return { calls, connected, tasks };
}

it("advertises six tools, each with a root object schema that names its properties", async () => {
  const { connected } = await serve();
  const { tools } = await connected.client.listTools();
  expect(tools.map(({ name }) => name)).toEqual(TOOL_NAMES);
  for (const tool of tools) {
    expect(tool.inputSchema.type, tool.name).toBe("object");
    expect(
      Object.keys(tool.inputSchema.properties ?? {}).length,
      tool.name
    ).toBeGreaterThan(0);
    expect(tool.inputSchema.properties, tool.name).toHaveProperty(
      tool.name === "list" || tool.name === "get" ? "resource" : "workspace"
    );
  }
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const list = byName.get("list");
  expect(list?.annotations?.readOnlyHint).toBe(true);
  expect(byName.get("get")?.annotations?.readOnlyHint).toBe(true);
  expect(Object.keys(list?.inputSchema.properties ?? {}).sort()).toEqual([
    "cursor",
    "depth",
    "fields",
    "filter",
    "limit",
    "resource",
    "workspace",
  ]);
  expect(list?.inputSchema.required).toEqual(["resource"]);
  expect(list?.inputSchema.properties?.resource).toMatchObject({
    enum: ["workspaces", "definitions", "tasks", "runs"],
  });
  expect(
    Object.keys(
      (
        list?.inputSchema.properties?.filter as
          | { properties?: object }
          | undefined
      )?.properties ?? {}
    ).sort()
  ).toEqual(["kind", "name", "parentId", "ready", "status", "tags"]);
  const get = byName.get("get");
  expect(Object.keys(get?.inputSchema.properties ?? {}).sort()).toEqual([
    "depth",
    "fields",
    "id",
    "resource",
    "workspace",
  ]);
  expect(get?.inputSchema.properties?.resource).toMatchObject({
    enum: ["workspace", "definition", "task", "run"],
  });
  expect(byName.get("enqueue_workflow")?.inputSchema.required).toEqual([
    "name",
  ]);
  expect(
    Object.keys(byName.get("cancel_run")?.inputSchema.properties ?? {}).sort()
  ).toEqual(["id", "workspace"]);
  for (const name of ["list", "get", "change_tasks"]) {
    expect(byName.get(name)?.outputSchema?.type, name).toBe("object");
  }
});

it("lists workspaces offline with source for config, default fields, projection and pages", async () => {
  const { connected } = await serve();
  expect(
    structured(await connected.call("list", { resource: "workspaces" }))
  ).toEqual({
    items: [
      { id: "own", root: "/own", source: "/own/marbles.ts", state: "ready" },
      { id: "idle", root: "/idle", source: null, state: "stopped" },
      {
        error: "still loading",
        id: "boot",
        root: "/boot",
        source: "/boot/marbles.ts",
        state: "starting",
      },
    ],
    total: 3,
  });
  expect(
    structured(
      await connected.call("list", {
        fields: ["pid"],
        limit: 2,
        resource: "workspaces",
      })
    )
  ).toEqual({
    items: [{ id: "own", pid: 7 }, { id: "idle" }],
    nextCursor: 2,
    total: 3,
  });
  expect(
    structured(
      await connected.call("list", {
        cursor: 2,
        fields: ["state"],
        resource: "workspaces",
      })
    )
  ).toEqual({ items: [{ id: "boot", state: "starting" }], total: 3 });
  for (const [args, code, mentions] of [
    [{ workspace: "own" }, "invalid_argument", "takes no workspace"],
    [{ depth: 1 }, "invalid_argument", "takes no depth"],
    [{ filter: { name: "own" } }, "invalid_filter", "takes no filter"],
    [{ fields: ["config"] }, "invalid_fields", '"config"'],
  ] as const) {
    const answer = refused(
      await connected.call("list", { resource: "workspaces", ...args })
    );
    expect(answer.code, JSON.stringify(args)).toBe(code);
    expect(answer.message).toContain(mentions);
  }
  const fields = refused(
    await connected.call("list", {
      fields: ["config"],
      resource: "workspaces",
    })
  );
  expect(fields.message).toContain(
    '"id", "root", "source", "state", "error", "pid"'
  );
});

it("lists definitions from the hosted workspace, filtered by kind and name, keeping name", async () => {
  const { connected } = await serve();
  expect(
    structured(await connected.call("list", { resource: "definitions" }))
  ).toEqual({
    items: [
      { description: "Greets", kind: "workflow", name: "greeting" },
      { kind: "step", name: "greet" },
      { kind: "step", name: "tidy" },
    ],
    total: 3,
  });
  expect(
    structured(
      await connected.call("list", {
        fields: ["inputSchema", "origin"],
        filter: { kind: "workflow" },
        resource: "definitions",
      })
    )
  ).toEqual({
    items: [
      {
        inputSchema: { type: "object" },
        name: "greeting",
        origin: "/own/marbles.ts:3",
      },
    ],
    total: 1,
  });
  expect(
    structured(
      await connected.call("list", {
        fields: ["kind"],
        filter: { kind: "step" },
        limit: 1,
        resource: "definitions",
      })
    )
  ).toEqual({
    items: [{ kind: "step", name: "greet" }],
    nextCursor: 1,
    total: 2,
  });
  expect(
    structured(
      await connected.call("list", {
        filter: { name: "tidy" },
        resource: "definitions",
      })
    )
  ).toMatchObject({ items: [{ name: "tidy" }], total: 1 });
  const wrongKind = refused(
    await connected.call("list", {
      filter: { kind: "agent" },
      resource: "definitions",
    })
  );
  expect(wrongKind.code).toBe("invalid_filter");
  expect(wrongKind.message).toContain("kind");
  const wrongKey = refused(
    await connected.call("list", {
      filter: { status: "queued" },
      resource: "definitions",
    })
  );
  expect(wrongKey).toEqual({
    code: "invalid_filter",
    message: 'list definitions takes filter keys "kind", "name"; got "status"',
  });
  expect(
    refused(
      await connected.call("list", {
        resource: "definitions",
        workspace: "boot",
      })
    ).code
  ).toBe("not_ready");
});

it("lists tasks offline with updatedAt by default, projecting nested subtasks", async () => {
  const { calls, connected, tasks } = await serve();
  const epic = await tasks.create({ tags: ["big"], title: "Epic" });
  const child = await tasks.create(
    { description: "inner", title: "Child" },
    { parent: { id: epic.id } }
  );
  const listed = structured(
    await connected.call("list", { resource: "tasks" })
  );
  expect(listed).toEqual({
    items: [
      {
        id: epic.id,
        parentId: null,
        status: "open",
        tags: ["big"],
        title: "Epic",
        updatedAt: epic.updatedAt,
      },
      {
        id: child.id,
        parentId: epic.id,
        status: "open",
        tags: [],
        title: "Child",
        updatedAt: child.updatedAt,
      },
    ],
    total: 2,
  });
  expect(
    structured(
      await connected.call("list", {
        depth: 1,
        fields: ["title", "description"],
        filter: { parentId: null },
        resource: "tasks",
      })
    )
  ).toEqual({
    items: [
      {
        description: null,
        id: epic.id,
        subtasks: [{ description: "inner", id: child.id, title: "Child" }],
        title: "Epic",
      },
    ],
    total: 1,
  });
  expect(
    structured(
      await connected.call("list", {
        fields: ["title"],
        filter: { ready: true, tags: { any: ["big"] } },
        resource: "tasks",
      })
    )
  ).toEqual({ items: [{ id: epic.id, title: "Epic" }], total: 1 });
  expect(calls.filter(([what]) => what === "tasks")).toEqual([
    ["tasks", "list", "own"],
    ["tasks", "list", "own"],
    ["tasks", "ready", "own"],
  ]);
  const wrongKey = refused(
    await connected.call("list", { filter: { kind: "x" }, resource: "tasks" })
  );
  expect(wrongKey).toEqual({
    code: "invalid_filter",
    message:
      'list tasks takes filter keys "status", "parentId", "tags", "ready"; got "kind"',
  });
});

it("lists runs newest first from the hosted workspace, mapping its filter to the query", async () => {
  const { calls, connected } = await serve();
  expect(
    structured(await connected.call("list", { resource: "runs" }))
  ).toEqual({
    items: [
      {
        id: "rn-3",
        kind: "agent",
        name: "helper",
        queuedAt: "2026-01-03T00:00:00.000Z",
        status: "running",
      },
      {
        id: "rn-2",
        kind: "workflow",
        name: "greeting",
        queuedAt: "2026-01-02T00:00:00.000Z",
        status: "completed",
      },
    ],
    total: 2,
  });
  expect(
    structured(
      await connected.call("list", {
        cursor: 1,
        fields: ["session", "endedAt"],
        filter: { kind: "agent", name: "helper", status: "completed" },
        limit: 5,
        resource: "runs",
      })
    ).items
  ).toEqual([
    { id: "rn-3", session: { id: "s1", instance: "i1" } },
    { endedAt: "2026-01-02T00:00:02.000Z", id: "rn-2" },
  ]);
  await connected.call("list", {
    filter: { status: ["queued", "failed"] },
    resource: "runs",
  });
  await connected.call("list", {
    filter: { status: "suspended" },
    resource: "runs",
  });
  expect(calls.filter(([what]) => what === "listRuns")).toEqual([
    ["listRuns", {}],
    [
      "listRuns",
      {
        cursor: 1,
        kind: "agent",
        limit: 5,
        name: "helper",
        status: ["completed"],
      },
    ],
    ["listRuns", { status: ["queued", "failed"] }],
    ["listRuns", { status: ["suspended"] }],
  ]);
  for (const filter of [
    { status: "complete" },
    { status: [] },
    { kind: "step" },
    { ready: true },
  ]) {
    expect(
      refused(await connected.call("list", { filter, resource: "runs" })).code,
      JSON.stringify(filter)
    ).toBe("invalid_filter");
  }
  expect(
    refused(
      await connected.call("list", { fields: ["output"], resource: "runs" })
    ).code
  ).toBe("invalid_fields");
});

it("tells the caller to restart a Marbles process that predates listRuns, without misclassifying other tools", async () => {
  const { connected } = await serve({
    getRun: () =>
      Promise.reject(
        new RemoteError({ message: 'no workspace method "custom"' })
      ),
    listRuns: () =>
      Promise.reject(
        new RemoteError({ message: 'no workspace method "listRuns"' })
      ),
  });
  const answer = refused(await connected.call("list", { resource: "runs" }));
  expect(answer.code).toBe("daemon_outdated");
  expect(answer.message).toContain("listRuns");
  expect(answer.message).toContain("marbles daemon stop");
  const unrelated = refused(
    await connected.call("get", { id: "rn-2", resource: "run" })
  );
  expect(unrelated).toEqual({
    code: "failed",
    message: 'no workspace method "custom"',
  });
});

it("propagates unexpected describe() errors on get workspace even when fields is omitted", async () => {
  const { connected } = await serve({
    describe: () => Promise.reject(new Error("connection closed unexpectedly")),
  });
  expect(
    refused(await connected.call("get", { resource: "workspace" }))
  ).toEqual({
    code: "failed",
    message: "connection closed unexpectedly",
  });
});

it("gets a workspace's summary offline, and its config only once it is hosted and ready", async () => {
  const { connected } = await serve();
  const own = structured(
    await connected.call("get", { resource: "workspace" })
  );
  expect(own).toEqual({
    item: {
      agents: CONFIG.agents,
      definitions: CONFIG.definitions,
      id: "own",
      monitors: [],
      observers: CONFIG.observers,
      pid: 7,
      root: "/own",
      schedules: [],
      source: "/own/marbles.ts",
      state: "ready",
    },
  });
  expect(
    structured(
      await connected.call("get", {
        fields: ["agents"],
        id: "own",
        resource: "workspace",
      })
    )
  ).toEqual({ item: { agents: CONFIG.agents, id: "own" } });
  expect(
    structured(
      await connected.call("get", { id: "idle", resource: "workspace" })
    )
  ).toEqual({
    item: { id: "idle", root: "/idle", source: null, state: "stopped" },
  });
  expect(
    structured(
      await connected.call("get", {
        fields: ["state", "error"],
        id: "boot",
        resource: "workspace",
      })
    )
  ).toEqual({
    item: { error: "still loading", id: "boot", state: "starting" },
  });
  const notReady = refused(
    await connected.call("get", {
      fields: ["definitions"],
      id: "boot",
      resource: "workspace",
    })
  );
  expect(notReady.code).toBe("not_ready");
  expect(
    refused(
      await connected.call("get", { id: "missing", resource: "workspace" })
    ).code
  ).toBe("not_found");
  expect(
    refused(
      await connected.call("get", { resource: "workspace", workspace: "own" })
    ).code
  ).toBe("invalid_argument");
  expect(
    refused(
      await connected.call("get", { fields: ["config"], resource: "workspace" })
    ).code
  ).toBe("invalid_fields");
});

it("answers not_hosted for config fields of a workspace nothing hosts", async () => {
  const { connected } = await serve({}, []);
  expect(
    structured(await connected.call("get", { resource: "workspace" })).item
  ).toEqual({
    id: "own",
    pid: 7,
    root: "/own",
    source: "/own/marbles.ts",
    state: "ready",
  });
  const connectedAgain = await connectMcp({
    workspaces: () => Promise.resolve(SUMMARIES),
  });
  open.push(connectedAgain);
  const answer = refused(
    await connectedAgain.call("get", {
      fields: ["schedules"],
      resource: "workspace",
    })
  );
  expect(answer).toEqual({
    code: "not_hosted",
    message: "nothing hosts workspace own in this test",
  });
});

it("gets a definition by name, a task with opt-in dependencies, and a run's full shape", async () => {
  const { calls, connected, tasks } = await serve();
  expect(
    structured(
      await connected.call("get", { id: "greeting", resource: "definition" })
    )
  ).toEqual({ item: CONFIG.definitions[0] });
  expect(
    structured(
      await connected.call("get", {
        fields: ["kind"],
        id: "greet",
        resource: "definition",
      })
    )
  ).toEqual({ item: { kind: "step", name: "greet" } });
  expect(
    refused(await connected.call("get", { id: "nope", resource: "definition" }))
      .code
  ).toBe("not_found");

  const first = await tasks.create({ title: "First" });
  const second = await tasks.create(
    { title: "Second" },
    { dependsOn: [{ id: first.id }], parent: { id: first.id } }
  );
  const plain = structured(
    await connected.call("get", { id: first.id, resource: "task" })
  ).item as Record<string, unknown>;
  expect(Object.keys(plain).sort()).toEqual([
    "createdAt",
    "description",
    "id",
    "metadata",
    "parentId",
    "settledAt",
    "status",
    "tags",
    "title",
    "updatedAt",
  ]);
  expect(
    structured(
      await connected.call("get", {
        depth: 1,
        fields: ["title"],
        id: first.id,
        resource: "task",
      })
    )
  ).toEqual({
    item: {
      id: first.id,
      subtasks: [{ id: second.id, title: "Second" }],
      title: "First",
    },
  });
  const beforeInspect = calls.length;
  const related = structured(
    await connected.call("get", {
      fields: ["dependsOn", "dependents"],
      id: second.id,
      resource: "task",
    })
  );
  expect(related).toEqual({
    item: {
      dependents: [],
      dependsOn: [expect.objectContaining({ id: first.id })],
      id: second.id,
    },
  });
  expect(calls.slice(beforeInspect)).toEqual([["tasks", "inspect", "own"]]);

  expect(
    structured(await connected.call("get", { id: "rn-2", resource: "run" }))
  ).toEqual({
    item: {
      endedAt: RUN.endedAt,
      id: "rn-2",
      kind: "workflow",
      name: "greeting",
      output: { greeting: "Hello" },
      queuedAt: RUN.queuedAt,
      startedAt: RUN.startedAt,
      status: "completed",
    },
  });
  expect(
    structured(
      await connected.call("get", {
        fields: ["status"],
        id: "rn-2",
        resource: "run",
      })
    )
  ).toEqual({ item: { id: "rn-2", status: "completed" } });
  expect(
    refused(await connected.call("get", { id: "rn-x", resource: "run" }))
  ).toEqual({ code: "not_found", message: 'no run "rn-x" in this host' });
  expect(
    refused(
      await connected.call("get", { depth: 1, id: "rn-2", resource: "run" })
    ).code
  ).toBe("invalid_argument");
  expect(
    refused(await connected.call("get", { resource: "definition" }))
  ).toEqual({
    code: "invalid_argument",
    message: "get definition needs an id: the definition's name",
  });
});

it("enqueues a workflow by name and key, dispatches an agent, and cancels a run by id", async () => {
  const { calls, connected } = await serve();
  const first = structured(
    await connected.call("enqueue_workflow", {
      input: { name: "Ada" },
      key: "k1",
      name: "greeting",
    })
  );
  expect(first).toEqual({
    id: "rn-k1",
    kind: "workflow",
    name: "greeting",
    status: "queued",
  });
  expect(
    structured(
      await connected.call("enqueue_workflow", { key: "k1", name: "greeting" })
    )
  ).toEqual(first);
  await connected.call("enqueue_workflow", { name: "greeting" });
  expect(calls.filter(([what]) => what === "dispatchWorkflow")).toEqual([
    ["dispatchWorkflow", "greeting", { name: "Ada" }, { key: "k1" }],
    ["dispatchWorkflow", "greeting", undefined, { key: "k1" }],
    ["dispatchWorkflow", "greeting", undefined, undefined],
  ]);
  expect(
    structured(
      await connected.call("dispatch_agent", { agent: "helper", prompt: "Hi" })
    )
  ).toEqual({
    id: "rn-agent",
    kind: "agent",
    name: "helper",
    session: { id: "s9", instance: "i9" },
    status: "queued",
  });
  expect(
    structured(await connected.call("cancel_run", { id: "rn-2" }))
  ).toMatchObject({ id: "rn-2", status: "cancelled" });
  expect(calls).toContainEqual(["cancelRun", "rn-2"]);
  expect(
    textOf(
      await connected.call("enqueue_workflow", { key: "   ", name: "greeting" })
    )
  ).toContain("Input validation error");
  expect(
    textOf(await connected.call("cancel_run", { runId: "rn-2" }))
  ).toContain("Input validation error");
});

it("answers every tool's refusal as {error: {code, message}}, keeping the dry-run hint", async () => {
  const hint =
    "A dry run of a workflow goes through `marbles run <name> --dry-run`.";
  const { connected } = {
    connected: await connectMcp({
      hosted: () =>
        Promise.reject(
          new (class extends Error {
            override readonly name = "NotHostedError";
          })(`--dry-run joins no Marbles process. ${hint}`)
        ),
      tasks: () => Promise.reject(new Error("tasks broke")),
      workspaces: () => Promise.resolve(SUMMARIES),
    }),
  };
  open.push(connected);
  for (const [name, args] of [
    ["list", { resource: "definitions" }],
    ["list", { resource: "runs" }],
    ["get", { id: "greeting", resource: "definition" }],
    ["get", { id: "rn-1", resource: "run" }],
    ["get", { fields: ["agents"], resource: "workspace" }],
    ["enqueue_workflow", { name: "greeting" }],
    ["dispatch_agent", { prompt: "Hi" }],
    ["cancel_run", { id: "rn-1" }],
  ] as const) {
    const answer = refused(await connected.call(name, args));
    expect(answer.code, name).toBe("not_hosted");
    expect(answer.message, name).toContain(hint);
  }
  for (const [name, args] of [
    ["list", { resource: "tasks" }],
    ["get", { id: "t", resource: "task" }],
    [
      "change_tasks",
      {
        operations: [{ input: { title: "x" }, key: "x", kind: "task.create" }],
      },
    ],
  ] as const) {
    expect(refused(await connected.call(name, args)), name).toEqual({
      code: "failed",
      message: "tasks broke",
    });
  }
});

it("reports daemon_outdated when get task with relations hits an older daemon rejecting inspect", async () => {
  const connected = await connectMcp({
    hosted: () => Promise.reject(new Error("unused")),
    tasks: (command) => {
      if (command.kind === "inspect") {
        const error = new Error(
          'Invalid discriminator value. Expected "list" | "get" | "dependencies" | "change", received "inspect"'
        );
        error.name = "ZodError";
        return Promise.reject(error);
      }
      return Promise.reject(new Error("unexpected"));
    },
    workspaces: () => Promise.resolve(SUMMARIES),
  });
  open.push(connected);
  const answer = refused(
    await connected.call("get", {
      fields: ["dependsOn"],
      id: "t-1",
      resource: "task",
    })
  );
  expect(answer.code).toBe("daemon_outdated");
  expect(answer.message).toContain("tasks inspect");
});

it("preserves TaskError not_found when get task with relations asks for task id 'inspect'", async () => {
  const { TaskError } = await import("@foundry/tasks");
  const connected = await connectMcp({
    hosted: () => Promise.reject(new Error("unused")),
    tasks: () =>
      Promise.reject(new TaskError("not_found", "Task inspect not found")),
    workspaces: () => Promise.resolve(SUMMARIES),
  });
  open.push(connected);
  const answer = refused(
    await connected.call("get", {
      fields: ["dependsOn"],
      id: "inspect",
      resource: "task",
    })
  );
  expect(answer).toEqual({
    code: "not_found",
    message: "[tasks] Task inspect not found",
  });
});
