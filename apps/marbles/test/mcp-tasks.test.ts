import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReentrantCallError } from "@foundry/lib/turns";
import { Tasks } from "@foundry/tasks";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { DatabaseBusyError } from "~/database/busy";
import { TaskStorageError } from "~/database/tasks";
import { hostTasks } from "~/workspace/open";
import { runTaskCommand } from "~/workspace/tasks";
import { testEngine } from "./helpers/engine";
import {
  connectMcp,
  refused,
  type ToolResult,
  textOf,
} from "./helpers/mcp-client";

vi.mock("bun", () => ({ plugin: vi.fn() }));

const clock = () => new Date("2026-10-29T00:00:00.000Z");
const MAX_PAGE = 200;

const open: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of open.splice(0)) {
    await close();
  }
});

async function connect(tasks = new Tasks({ clock })) {
  const addressed: (string | undefined)[] = [];
  const connected = await connectMcp({
    tasks: (command, workspace) => {
      addressed.push(workspace);
      return runTaskCommand(tasks, command);
    },
  });
  open.push(() => connected.close());
  return { addressed, client: connected.client, connected, tasks };
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolResult> {
  return CallToolResultSchema.parse(
    await client.callTool({ arguments: args, name })
  );
}

const tasksIn = (filter?: Record<string, unknown>, rest = {}) => ({
  resource: "tasks",
  ...(filter === undefined ? {} : { filter }),
  ...rest,
});

const taskShape = z.object({ id: z.string(), title: z.string() }).loose();
const changed = z.object({
  changed: z.array(z.object({ id: z.string(), key: z.string().optional() })),
  tasks: z.array(taskShape.extend({ updatedAt: z.string() })),
});
const page = z.object({
  items: z.array(taskShape),
  nextCursor: z.number().optional(),
  total: z.number(),
});

it("serves tasks through list, get and change_tasks, addressed to this server's workspace by default", async () => {
  const { addressed, client } = await connect();
  const { tools } = await client.listTools();
  const change = tools.find(({ name }) => name === "change_tasks");
  expect(change?.inputSchema.required).toEqual(["operations"]);
  expect(change?.outputSchema?.type).toBe("object");
  expect(change?.annotations?.readOnlyHint).toBe(false);
  const list = tools.find(({ name }) => name === "list");
  expect(list?.annotations?.readOnlyHint).toBe(true);
  await call(client, "list", tasksIn(undefined, { workspace: "elsewhere" }));
  await call(client, "change_tasks", {
    operations: [{ input: { title: "Here" }, key: "a", kind: "task.create" }],
  });
  expect(addressed).toEqual(["elsewhere", "own"]);
});

it("commits, returns, and filters tags over a workspace's own records", async () => {
  const state = await mkdtemp(join(tmpdir(), "marbles-mcp-records-"));
  const engine = testEngine({ state });
  open.push(async () => {
    await engine.dispose();
    await rm(state, { force: true, recursive: true });
  });
  const { client, tasks } = await connect(hostTasks(engine));

  const plain = await call(client, "change_tasks", {
    operations: [{ input: { title: "Plain" }, key: "a", kind: "task.create" }],
  });
  expect(plain.isError, textOf(plain)).not.toBe(true);
  expect(plain.structuredContent).toMatchObject({
    tasks: [{ tags: [], title: "Plain" }],
  });
  const [tagged] = changed.parse(
    (
      await call(client, "change_tasks", {
        operations: [
          {
            input: { tags: ["review", "api", "review"], title: "Tagged" },
            key: "t",
            kind: "task.create",
          },
        ],
      })
    ).structuredContent
  ).tasks;
  expect(tagged).toMatchObject({ tags: ["review", "api"] });

  const titles = async (filter: Record<string, unknown>) => {
    const result = await call(client, "list", tasksIn(filter));
    expect(result.isError, textOf(result)).not.toBe(true);
    return page.parse(result.structuredContent).items.map(({ title }) => title);
  };
  expect(await titles({ tags: { all: ["review"] } })).toEqual(["Tagged"]);
  expect(
    await titles({ ready: true, tags: { any: ["missing", "api"] } })
  ).toEqual(["Tagged"]);
  expect(await titles({ tags: {} })).toEqual(["Plain", "Tagged"]);

  const retagged = await call(client, "change_tasks", {
    operations: [
      {
        expectedUpdatedAt: tagged?.updatedAt,
        kind: "task.update",
        patch: { tags: [] },
        task: { id: tagged?.id },
      },
    ],
  });
  expect(retagged.isError, textOf(retagged)).not.toBe(true);
  const read = await call(client, "get", { id: tagged?.id, resource: "task" });
  expect(read.structuredContent).toMatchObject({ item: { tags: [] } });
  expect(await titles({ tags: { all: ["review"] } })).toEqual([]);
  expect((await tasks.list()).total).toBe(2);
  const other = new Tasks({ store: engine.taskStore });
  expect((await other.get(tagged?.id ?? ""))?.tags).toEqual([]);
});

it("publishes metadata as a JSON object and refuses a __proto__ key in it", async () => {
  const { client, tasks } = await connect();
  const { tools } = await client.listTools();
  const change = tools.find(({ name }) => name === "change_tasks");
  const published = JSON.stringify(change?.inputSchema);
  const typed =
    '"metadata":{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{"$ref":';
  expect(published.split(typed)).toHaveLength(3);

  const task = await tasks.create({ metadata: { keep: 1 }, title: "proto" });
  const metadata = JSON.parse('{"x":{"__proto__":1}}');
  const result = await call(client, "change_tasks", {
    operations: [
      { kind: "task.update", patch: { metadata }, task: { id: task.id } },
    ],
  });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain(
    '"__proto__" is not allowed as a metadata key'
  );
  expect((await tasks.get(task.id))?.metadata).toEqual({ keep: 1 });
});

it("creates, reads, and changes tasks through the shared command language", async () => {
  const { client, tasks } = await connect();
  const created = await call(client, "change_tasks", {
    operations: [
      { input: { title: "Epic" }, key: "epic", kind: "task.create" },
      {
        input: { title: "Design" },
        key: "design",
        kind: "task.create",
        parent: { key: "epic" },
      },
      {
        input: { metadata: { size: "m" }, title: "Build" },
        key: "build",
        kind: "task.create",
        parent: { key: "epic" },
      },
      {
        dependsOn: { key: "design" },
        kind: "dependency.add",
        task: { key: "build" },
      },
    ],
  });
  expect(created.isError).not.toBe(true);
  const result = changed.parse(created.structuredContent);
  expect(JSON.parse(textOf(created))).toEqual(created.structuredContent);
  const [epic, design, build] = result.tasks;
  if (!(epic && design && build)) {
    throw new Error("the batch reported fewer tasks");
  }
  expect(result.changed.map(({ key }) => key)).toEqual([
    "epic",
    "design",
    "build",
  ]);
  expect((await tasks.get(build.id))?.metadata).toEqual({ size: "m" });

  const tree = await call(client, "get", {
    depth: 1,
    id: epic.id,
    resource: "task",
  });
  expect(tree.structuredContent).toMatchObject({
    item: {
      id: epic.id,
      subtasks: [{ id: design.id }, { id: build.id }],
    },
  });
  const roots = page.parse(
    (await call(client, "list", tasksIn({ parentId: null }))).structuredContent
  );
  expect(roots.items.map(({ id }) => id)).toEqual([epic.id]);
  const ready = page.parse(
    (await call(client, "list", tasksIn({ ready: true }))).structuredContent
  );
  expect(ready.items.map(({ id }) => id)).toEqual([epic.id, design.id]);
  expect(
    (
      await call(client, "get", {
        fields: ["dependsOn", "dependents"],
        id: build.id,
        resource: "task",
      })
    ).structuredContent
  ).toEqual({
    item: {
      dependents: [],
      dependsOn: [expect.objectContaining({ id: design.id })],
      id: build.id,
    },
  });

  const done = await call(client, "change_tasks", {
    operations: [
      {
        expectedUpdatedAt: design.updatedAt,
        kind: "task.set_status",
        status: "completed",
        task: { id: design.id },
      },
    ],
  });
  expect(done.isError).not.toBe(true);
  const nowReady = page.parse(
    (await call(client, "list", tasksIn({ ready: true }))).structuredContent
  );
  expect(nowReady.items.map(({ id }) => id)).toEqual([epic.id, build.id]);
});

it("refuses a stale token or an invalid batch and leaves the backlog unchanged", async () => {
  const { client, tasks } = await connect();
  const first = await tasks.create({ title: "First" });
  const second = await tasks.create(
    { title: "Second" },
    {
      dependsOn: [{ id: first.id }],
    }
  );
  const updated = await tasks.update(first.id, { title: "First, renamed" });
  const before = await tasks.list({ depth: 1 });

  const stale = refused(
    await call(client, "change_tasks", {
      operations: [
        {
          kind: "task.update",
          patch: { title: "Lost update" },
          task: { id: second.id },
        },
        {
          expectedUpdatedAt: first.updatedAt,
          kind: "task.update",
          patch: { title: "Overwrite" },
          task: { id: first.id },
        },
      ],
    })
  );
  expect(stale.code).toBe("conflict");
  expect(await tasks.list({ depth: 1 })).toEqual(before);

  const cycle = refused(
    await call(client, "change_tasks", {
      operations: [
        { input: { title: "Never kept" }, key: "new", kind: "task.create" },
        {
          dependsOn: { id: second.id },
          kind: "dependency.add",
          task: { id: first.id },
        },
      ],
    })
  );
  expect(cycle.code).toBe("cycle");
  expect(await tasks.list({ depth: 1 })).toEqual(before);

  const missing = refused(
    await call(client, "change_tasks", {
      operations: [
        { kind: "task.set_status", status: "active", task: { id: "nope" } },
      ],
    })
  );
  expect(missing.code).toBe("not_found");
  expect(await tasks.list({ depth: 1 })).toEqual(before);

  const current = await call(client, "change_tasks", {
    operations: [
      {
        expectedUpdatedAt: updated.updatedAt,
        kind: "task.set_status",
        status: "active",
        task: { id: first.id },
      },
    ],
  });
  expect(current.isError).not.toBe(true);
});

it("validates input before running anything, and answers refusals with a code", async () => {
  const { client, tasks } = await connect();
  const malformed: [string, Record<string, unknown>][] = [
    ["list", tasksIn({ tags: ["review"] })],
    ["list", tasksIn({ ready: true, tags: { all: [1] } })],
    ["list", tasksIn(undefined, { limit: 0 })],
    ["list", tasksIn(undefined, { cursor: -1 })],
    ["list", tasksIn(undefined, { depth: 1.5 })],
    ["list", { resource: "task" }],
    ["get", { id: "", resource: "task" }],
    ["change_tasks", {}],
    ["change_tasks", { operations: [] }],
    [
      "change_tasks",
      { operations: [{ kind: "task.remove", task: { id: "x" } }] },
    ],
    [
      "change_tasks",
      {
        operations: [{ input: { title: "" }, key: "a", kind: "task.create" }],
      },
    ],
    [
      "change_tasks",
      {
        operations: [
          {
            expectedUpdatedAt: "yesterday",
            kind: "task.set_status",
            status: "open",
            task: { id: "x" },
          },
        ],
      },
    ],
  ];
  for (const [name, args] of malformed) {
    const result = await call(client, name, args);
    expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    expect(textOf(result)).toContain("Input validation error");
  }
  const refusedBefore: [Record<string, unknown>, string, string][] = [
    [tasksIn({ labels: ["review"] }), "invalid_filter", '"labels"'],
    [tasksIn({ tags: { none: ["review"] } }), "invalid_filter", "none"],
    [tasksIn({ status: "done" }), "invalid_filter", "status"],
    [tasksIn({ status: ["open"] }), "invalid_filter", "status"],
    [tasksIn({ ready: false }), "invalid_filter", "only true"],
    [tasksIn({ ready: true, status: "open" }), "invalid_filter", '"status"'],
    [tasksIn({ parentId: null, ready: true }), "invalid_filter", '"parentId"'],
    [tasksIn({ ready: true }, { depth: 1 }), "invalid_argument", "depth"],
    [tasksIn(undefined, { fields: ["owner"] }), "invalid_fields", '"owner"'],
  ];
  for (const [args, code, mentions] of refusedBefore) {
    const answer = refused(await call(client, "list", args));
    expect(answer.code, JSON.stringify(args)).toBe(code);
    expect(answer.message, JSON.stringify(args)).toContain(mentions);
  }
  expect(refused(await call(client, "get", { resource: "task" }))).toEqual({
    code: "invalid_argument",
    message: "get task needs an id: the task's id",
  });
  expect((await tasks.list()).total).toBe(0);

  expect(
    refused(await call(client, "get", { id: "nope", resource: "task" }))
  ).toEqual({
    code: "not_found",
    message: "[tasks] Task nope not found",
  });
  expect(
    refused(
      await call(client, "get", {
        fields: ["dependsOn"],
        id: "nope",
        resource: "task",
      })
    ).code
  ).toBe("not_found");
});

it("pages through the backlog with a bounded limit", async () => {
  const { client, tasks } = await connect();
  await tasks.change({
    operations: Array.from({ length: 100 }, (_, index) => ({
      input: { title: `Task ${index}` },
      key: `k${index}`,
      kind: "task.create" as const,
    })),
  });
  await tasks.change({
    operations: Array.from({ length: 100 }, (_, index) => ({
      input: { title: `More ${index}` },
      key: `m${index}`,
      kind: "task.create" as const,
    })),
  });
  await tasks.change({
    operations: Array.from({ length: 5 }, (_, index) => ({
      input: { title: `More ${index + 100}` },
      key: `m${index + 100}`,
      kind: "task.create" as const,
    })),
  });
  const capped = page.parse(
    (await call(client, "list", tasksIn(undefined, { limit: 10_000 })))
      .structuredContent
  );
  expect(capped.items).toHaveLength(MAX_PAGE);
  expect(capped.total).toBe(205);
  expect(capped.nextCursor).toBe(MAX_PAGE);
  const rest = page.parse(
    (
      await call(
        client,
        "list",
        tasksIn(undefined, { cursor: capped.nextCursor })
      )
    ).structuredContent
  );
  expect(rest.items).toHaveLength(5);
  expect(rest.nextCursor).toBeUndefined();
  const small = page.parse(
    (
      await call(
        client,
        "list",
        tasksIn({ ready: true }, { cursor: 3, limit: 2 })
      )
    ).structuredContent
  );
  expect(small.items.map(({ title }) => title)).toEqual(["Task 3", "Task 4"]);
  expect(small.nextCursor).toBe(5);
});

it("answers a storage refusal or a re-entrant call with a coded tool error carrying its message", async () => {
  const refusals = [
    new ReentrantCallError(
      "SqliteTaskStore was called from inside its own transaction or onCommit hook; use the view passed to the transaction's work, or the transaction passed to onCommit, instead"
    ),
    new TaskStorageError(
      "this change cannot be stored in the Marbles database: SqliteTaskStore cannot store putTasks[0].title"
    ),
    new DatabaseBusyError("the Marbles database is busy"),
  ];
  for (const thrown of refusals) {
    const connected = await connectMcp({ tasks: () => Promise.reject(thrown) });
    open.push(() => connected.close());
    for (const [name, args] of [
      ["list", tasksIn()],
      ["get", { id: "x", resource: "task" }],
      [
        "change_tasks",
        {
          operations: [
            { input: { title: "x" }, key: "x", kind: "task.create" },
          ],
        },
      ],
    ] as const) {
      expect(refused(await connected.call(name, args))).toEqual({
        code: "failed",
        message: thrown.message,
      });
    }
  }
});
