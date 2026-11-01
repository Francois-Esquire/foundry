import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tasks } from "@foundry/tasks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerTaskTools } from "~/mcp/tasks";
import { hostTasks } from "~/workspace/open";
import { runTaskCommand } from "~/workspace/tasks";
import { testEngine } from "./helpers/engine";

// `~/workspace/open` loads sources through a Bun plugin; vitest runs under Node, and
// these tests load none.
vi.mock("bun", () => ({ plugin: vi.fn() }));

const clock = () => new Date("2026-10-29T00:00:00.000Z");
const MAX_PAGE = 200;

const open: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of open.splice(0)) {
    await close();
  }
});

/** A client connected in-process to the task tools over a real backlog. */
async function connect(tasks = new Tasks({ clock })) {
  const server = new McpServer({ name: "tasks-test", version: "1.0.0" });
  // The workspace each call named, as the server's runner received it.
  const addressed: (string | undefined)[] = [];
  registerTaskTools(
    server,
    (command, workspace) => {
      addressed.push(workspace);
      return runTaskCommand(tasks, command);
    },
    z.string().min(1).optional()
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tasks-client", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  open.push(async () => {
    await client.close();
    await server.close();
  });
  return { addressed, client, tasks };
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
) {
  return CallToolResultSchema.parse(
    await client.callTool({ arguments: args, name })
  );
}

/** The `{ code, message }` a refused command answers with. */
const refusal = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

function textOf(result: z.infer<typeof CallToolResultSchema>): string {
  const [block] = result.content;
  if (block?.type !== "text") {
    throw new Error("the result carried no text");
  }
  return block.text;
}

function refused(result: z.infer<typeof CallToolResultSchema>) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  return refusal.parse(JSON.parse(textOf(result))).error;
}

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

it("lists the task tools with input and output schemas", async () => {
  const { addressed, client } = await connect();
  const { tools } = await client.listTools();
  expect(tools.map(({ name }) => name)).toEqual([
    "list_tasks",
    "ready_tasks",
    "get_task",
    "task_dependencies",
    "change_tasks",
  ]);
  for (const tool of tools) {
    expect(tool.inputSchema.type, tool.name).toBe("object");
    expect(tool.outputSchema?.type, tool.name).toBe("object");
    // Like every Marbles tool, each can be pointed at a hosted workspace.
    expect(tool.inputSchema.properties, tool.name).toHaveProperty("workspace");
  }
  const change = tools.find(({ name }) => name === "change_tasks");
  expect(change?.inputSchema.required).toEqual(["operations"]);
  expect(change?.annotations?.readOnlyHint).toBe(false);
  const list = tools.find(({ name }) => name === "list_tasks");
  expect(list?.annotations?.readOnlyHint).toBe(true);
  expect(Object.keys(list?.inputSchema.properties ?? {}).sort()).toEqual([
    "cursor",
    "depth",
    "limit",
    "parentId",
    "status",
    "tags",
    "workspace",
  ]);
  // The workspace a call names reaches the runner beside the command, and
  // never the command itself.
  await call(client, "list_tasks", { workspace: "elsewhere" });
  await call(client, "change_tasks", {
    operations: [{ input: { title: "Here" }, key: "a", kind: "task.create" }],
  });
  expect(addressed).toEqual(["elsewhere", undefined]);
});

it("commits, returns, and filters tags over a workspace's own records", async () => {
  const state = await mkdtemp(join(tmpdir(), "marbles-mcp-records-"));
  const engine = testEngine({ state });
  open.push(async () => {
    await engine.dispose();
    await rm(state, { force: true, recursive: true });
  });
  const { client, tasks } = await connect(hostTasks(engine));

  // An ordinary create commits and answers without an output error.
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

  const titles = async (name: string, args: Record<string, unknown>) => {
    const result = await call(client, name, args);
    expect(result.isError, textOf(result)).not.toBe(true);
    return page.parse(result.structuredContent).items.map(({ title }) => title);
  };
  expect(await titles("list_tasks", { tags: { all: ["review"] } })).toEqual([
    "Tagged",
  ]);
  expect(
    await titles("ready_tasks", { tags: { any: ["missing", "api"] } })
  ).toEqual(["Tagged"]);
  expect(await titles("list_tasks", { tags: {} })).toEqual(["Plain", "Tagged"]);

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
  const read = await call(client, "get_task", { id: tagged?.id });
  expect(read.structuredContent).toMatchObject({ task: { tags: [] } });
  expect(await titles("list_tasks", { tags: { all: ["review"] } })).toEqual([]);
  // What the tools answered is what the workspace holds.
  expect((await tasks.list()).total).toBe(2);
  const other = new Tasks({ store: engine.taskStore });
  expect((await other.get(tagged?.id ?? ""))?.tags).toEqual([]);
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
  // The tools answered from the same backlog the library reads.
  expect((await tasks.get(build.id))?.metadata).toEqual({ size: "m" });

  const tree = await call(client, "get_task", { depth: 1, id: epic.id });
  expect(tree.structuredContent).toMatchObject({
    task: {
      id: epic.id,
      subtasks: [{ id: design.id }, { id: build.id }],
    },
  });
  const roots = page.parse(
    (await call(client, "list_tasks", { parentId: null })).structuredContent
  );
  expect(roots.items.map(({ id }) => id)).toEqual([epic.id]);
  const ready = page.parse(
    (await call(client, "ready_tasks")).structuredContent
  );
  expect(ready.items.map(({ id }) => id)).toEqual([epic.id, design.id]);
  expect(
    (await call(client, "task_dependencies", { id: build.id }))
      .structuredContent
  ).toMatchObject({ dependents: [], dependsOn: [{ id: design.id }] });

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
    (await call(client, "ready_tasks")).structuredContent
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

  // The token from the latest read is accepted.
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
  const invalid: [string, Record<string, unknown>][] = [
    ["list_tasks", { labels: ["review"] }],
    ["list_tasks", { tags: ["review"] }],
    ["list_tasks", { tags: { none: ["review"] } }],
    ["ready_tasks", { tags: { all: [1] } }],
    ["list_tasks", { status: "done" }],
    ["list_tasks", { limit: 0 }],
    ["list_tasks", { cursor: -1 }],
    ["list_tasks", { depth: 1.5 }],
    ["ready_tasks", { status: "open" }],
    ["get_task", {}],
    ["get_task", { id: "" }],
    ["task_dependencies", {}],
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
  for (const [name, args] of invalid) {
    const result = await call(client, name, args);
    expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    expect(textOf(result)).toContain("Input validation error");
  }
  expect((await tasks.list()).total).toBe(0);

  expect(refused(await call(client, "get_task", { id: "nope" }))).toEqual({
    code: "not_found",
    message: "[tasks] Task nope not found",
  });
  expect(
    refused(await call(client, "task_dependencies", { id: "nope" })).code
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
    operations: Array.from({ length: 105 }, (_, index) => ({
      input: { title: `More ${index}` },
      key: `m${index}`,
      kind: "task.create" as const,
    })),
  });
  const capped = page.parse(
    (await call(client, "list_tasks", { limit: 10_000 })).structuredContent
  );
  expect(capped.items).toHaveLength(MAX_PAGE);
  expect(capped.total).toBe(205);
  expect(capped.nextCursor).toBe(MAX_PAGE);
  const rest = page.parse(
    (await call(client, "list_tasks", { cursor: capped.nextCursor }))
      .structuredContent
  );
  expect(rest.items).toHaveLength(5);
  expect(rest.nextCursor).toBeUndefined();
  const small = page.parse(
    (await call(client, "ready_tasks", { cursor: 3, limit: 2 }))
      .structuredContent
  );
  expect(small.items.map(({ title }) => title)).toEqual(["Task 3", "Task 4"]);
  expect(small.nextCursor).toBe(5);
});
