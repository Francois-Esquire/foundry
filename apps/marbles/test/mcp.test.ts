import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { workspaceState } from "~/lib/state/workspace";
import { daemonAlive } from "~/process/client";
import { version } from "../package.json";
import { testHome } from "./helpers/home";
import {
  RecordedStdioTransport,
  rawMcpSession,
  serverPreload,
  strayLines,
} from "./helpers/mcp-stdio";
import {
  readWorkspace,
  seedWorkspace,
  touchWorkspace,
} from "./helpers/registry";

const TOOL_NAMES = [
  "list",
  "get",
  "enqueue_workflow",
  "dispatch_agent",
  "cancel_run",
  "change_tasks",
];

const WORKSPACES = { arguments: { resource: "workspaces" }, name: "list" };
const TASKS = { arguments: { resource: "tasks" }, name: "list" };
const runOf = (id: string) => ({
  arguments: { id, resource: "run" },
  name: "get",
});

function payload(value: unknown): unknown {
  const content = CallToolResultSchema.parse(value).content.find(
    (block) => block.type === "text"
  );
  if (content?.type !== "text") {
    throw new Error("tool returned no text");
  }
  return JSON.parse(content.text);
}

function runIdentity(value: unknown) {
  return z.object({ id: z.string() }).parse(payload(value));
}

const summarySchema = z.object({
  id: z.string(),
  root: z.string(),
  source: z.string().nullable(),
  state: z.string(),
});

function summaries(value: unknown) {
  return z.object({ items: summarySchema.array() }).parse(payload(value)).items;
}

it("dispatches workflows and agents through the MCP tools, over a workspace a dry-run host serves", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-"));
  const source = join(root, "marbles.ts");
  const schemaLibrary = createRequire(import.meta.url).resolve("zod");
  await writeFile(
    source,
    `import { agent, observe, step, tasks, workflow } from "@foundry.sh/marbles";
import { z } from ${JSON.stringify(schemaLibrary)};
agent({ name: "helper", prompt: "You help with tasks." });
observe(tasks, () => undefined, { name: "triage", types: ["tasks.changed"] });
const greet = step("greet").input(z.object({ name: z.string() })).do(({ input }) => {
  console.error("workflow diagnostic");
  return { greeting: "Hello " + input.name };
});
workflow("greeting").input(z.object({ name: z.string() })).do(({ input }) => greet({}, input));`
  );
  const transport = new RecordedStdioTransport({
    args: ["--no-env-file", resolve("test/helpers/dry-mcp-host.ts"), source],
    command: "bun",
    cwd: root,
    env: testHome().env,
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const client = new Client({ name: "marbles-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    expect(client.getServerVersion()?.version).toBe(version);
    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual(TOOL_NAMES);
    for (const tool of listed.tools) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.inputSchema.properties, tool.name).toHaveProperty(
        "workspace"
      );
    }
    const config = await client.callTool({
      arguments: { resource: "workspace" },
      name: "get",
    });
    expect(config.isError, JSON.stringify(config)).not.toBe(true);
    expect(config.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('"id":"helper"'),
      }),
    ]);
    expect(config.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('"inputSchema"'),
      }),
    ]);
    expect(payload(config)).toMatchObject({
      item: {
        observers: [
          { name: "triage", source: "tasks", types: ["tasks.changed"] },
        ],
      },
    });
    const definitions = await client.callTool({
      arguments: {
        fields: ["inputSchema"],
        filter: { kind: "workflow" },
        resource: "definitions",
      },
      name: "list",
    });
    expect(payload(definitions)).toMatchObject({
      items: [{ inputSchema: expect.any(Object), name: "greeting" }],
      total: 1,
    });
    const run = await client.callTool({
      arguments: { input: { name: "Ada" }, name: "greeting" },
      name: "enqueue_workflow",
    });
    const workflow = runIdentity(run);
    await vi.waitFor(async () => {
      const status = await client.callTool(runOf(workflow.id));
      expect(status.content).toEqual([
        expect.objectContaining({
          text: expect.stringContaining('"greeting":"Hello Ada"'),
        }),
      ]);
    });
    const invalid = await client.callTool({
      arguments: { input: { name: 42 }, name: "greet" },
      name: "enqueue_workflow",
    });
    expect(invalid.isError).toBe(true);
    const keyed = async () =>
      runIdentity(
        await client.callTool({
          arguments: { input: { name: "Key" }, key: "once", name: "greeting" },
          name: "enqueue_workflow",
        })
      ).id;
    const firstKeyed = await keyed();
    expect(firstKeyed).not.toBe(workflow.id);
    expect(await keyed()).toBe(firstKeyed);
    const missing = await client.callTool({
      arguments: { name: "missing" },
      name: "enqueue_workflow",
    });
    expect(missing.isError).toBe(true);
    expect(payload(missing)).toMatchObject({ error: { code: "not_found" } });
    const dispatched = await client.callTool({
      arguments: { agent: "helper", maxTurns: 3, prompt: "Hello agent" },
      name: "dispatch_agent",
    });
    expect(dispatched.isError, JSON.stringify(dispatched)).not.toBe(true);
    const job = runIdentity(dispatched);
    await vi.waitFor(async () => {
      const status = await client.callTool(runOf(job.id));
      expect(status.content).toEqual([
        expect.objectContaining({
          text: expect.stringContaining('"status":"completed"'),
        }),
      ]);
      expect(status.content).toEqual([
        expect.objectContaining({
          text: expect.stringContaining("Hello agent"),
        }),
      ]);
    });
    const { session } = z
      .object({
        session: z.looseObject({ id: z.string(), instance: z.string() }),
      })
      .parse(payload(dispatched));
    const continued = await client.callTool({
      arguments: { agent: "helper", prompt: "Hello again", session },
      name: "dispatch_agent",
    });
    expect(continued.isError, JSON.stringify(continued)).not.toBe(true);
    const followUp = runIdentity(continued);
    await vi.waitFor(async () => {
      const status = await client.callTool(runOf(followUp.id));
      expect(payload(status)).toMatchObject({
        item: {
          session: { id: session.id, instance: session.instance },
          status: "completed",
          text: expect.stringContaining("Hello again"),
        },
      });
    });
    const runs = z
      .object({
        items: z.array(
          z.object({ id: z.string(), kind: z.string(), status: z.string() })
        ),
        total: z.number(),
      })
      .parse(
        payload(
          await client.callTool({
            arguments: { filter: { status: "completed" }, resource: "runs" },
            name: "list",
          })
        )
      );
    expect(runs.items.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: followUp.id, kind: "agent" },
      { id: job.id, kind: "agent" },
      { id: firstKeyed, kind: "workflow" },
      { id: workflow.id, kind: "workflow" },
    ]);
    expect(runs.items[0]).toEqual({
      id: followUp.id,
      kind: "agent",
      status: "completed",
    });
    const unknown = await client.callTool({
      arguments: { agent: "missing", prompt: "Hello" },
      name: "dispatch_agent",
    });
    expect(unknown.isError).toBe(true);
    const invalidLimit = await client.callTool({
      arguments: { maxTurns: 0, prompt: "Hello" },
      name: "dispatch_agent",
    });
    expect(invalidLimit.isError).toBe(true);
    const missingJob = await client.callTool(runOf("missing"));
    expect(missingJob.isError).toBe(true);
    expect(payload(missingJob)).toMatchObject({ error: { code: "not_found" } });
    const cancelled = await client.callTool({
      arguments: { id: job.id },
      name: "cancel_run",
    });
    expect(cancelled.isError).not.toBe(true);
    expect(diagnostics).toContain("workflow diagnostic");
  } catch (error) {
    throw new Error(`MCP session failed:\n${diagnostics}`, { cause: error });
  } finally {
    await client.close();
    expect(transport.pid).toBeNull();
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

function toolAnswer(value: unknown): { isError: boolean; text: string } {
  const parsed = CallToolResultSchema.parse(value);
  const [block] = parsed.content;
  return {
    isError: parsed.isError === true,
    text: block?.type === "text" ? block.text : "",
  };
}

const DRY_REFUSAL =
  "A dry run of a workflow goes through `marbles run <name> --dry-run`.";

it("under --dry-run, loads no source, keeps tasks in memory, and refuses what needs a running instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-dry-"));
  const source = join(root, "marbles.ts");
  const home = testHome({ providers: false });
  const { state } = home.layout;
  await writeFile(
    source,
    `import { step, workflow } from "@foundry.sh/marbles";
console.error("SOURCE_LOADED");
workflow("greeting").do(() => step("greet").do(() => "hello")({}));`
  );
  const transport = new RecordedStdioTransport({
    args: [
      "--no-env-file",
      resolve("src/cli.ts"),
      "mcp",
      "--source",
      source,
      "--dry-run",
    ],
    command: "bun",
    cwd: root,
    env: home.env,
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const client = new Client({ name: "marbles-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual(TOOL_NAMES);
    const workspaces = summaries(await client.callTool(WORKSPACES));
    expect(workspaces).toEqual([
      expect.objectContaining({ source, state: "stopped" }),
    ]);
    expect(
      payload(
        await client.callTool({
          arguments: { resource: "workspace" },
          name: "get",
        })
      )
    ).toMatchObject({ item: { source, state: "stopped" } });
    for (const [name, args] of [
      ["list", { resource: "definitions" }],
      ["list", { resource: "runs" }],
      ["get", { fields: ["definitions"], resource: "workspace" }],
      ["get", { id: "greeting", resource: "definition" }],
      ["get", { id: "any", resource: "run" }],
      ["enqueue_workflow", { name: "greeting" }],
      ["dispatch_agent", { prompt: "Hello" }],
      ["cancel_run", { id: "any" }],
    ] as const) {
      const refused = toolAnswer(
        await client.callTool({ arguments: args, name })
      );
      expect(refused.isError, name).toBe(true);
      const { error } = z
        .object({ error: z.object({ code: z.string(), message: z.string() }) })
        .parse(JSON.parse(refused.text));
      expect(error.code, name).toBe("not_hosted");
      expect(error.message, name).toContain("marbles daemon attach");
      expect(error.message, name).toContain(DRY_REFUSAL);
    }
    const created = await client.callTool({
      arguments: {
        operations: [
          { input: { title: "Dry" }, key: "dry", kind: "task.create" },
        ],
      },
      name: "change_tasks",
    });
    expect(created.isError, JSON.stringify(created)).not.toBe(true);
    const tasks = await client.callTool(TASKS);
    expect(tasks.structuredContent).toMatchObject({
      items: [{ title: "Dry" }],
      total: 1,
    });
    const elsewhere = toolAnswer(
      await client.callTool({
        arguments: { resource: "tasks", workspace: "other" },
        name: "list",
      })
    );
    expect(elsewhere.isError).toBe(true);
    expect(elsewhere.text).toContain("is available under --dry-run");
  } catch (error) {
    throw new Error(`MCP session failed:\n${diagnostics}`, { cause: error });
  } finally {
    await client.close();
    expect(transport.pid).toBeNull();
    expect(diagnostics).not.toContain("SOURCE_LOADED");
    expect(existsSync(state)).toBe(false);
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it("keeps what the server process writes to stdout, natively or through a child, off the protocol stream", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-stdout-"));
  const { env: homeEnv } = testHome();
  const env = await serverPreload(
    root,
    `const { writeSync } = await import("node:fs");
process.stdout.write("NODE_STDOUT\\n");
console.log("CONSOLE_STDOUT");
await Bun.write(Bun.stdout, "NATIVE_STDOUT\\n");
Bun.spawnSync(["echo", "CHILD_STDOUT"], { stdout: "inherit" });
// What anything the server starts later inherits.
process.on("exit", () => {
  writeSync(2, "SERVER_MARKER=" + String(process.env.MARBLES_MCP_SERVER) + "\\n");
});`,
    homeEnv
  );
  const session = await rawMcpSession(
    "bun",
    ["--no-env-file", resolve("src/cli.ts"), "mcp", "--dry-run"],
    { cwd: root, env }
  );
  try {
    const listed = z
      .object({ result: z.object({ structuredContent: z.unknown() }) })
      .parse(await session.request("tools/call", TASKS));
    expect(listed.result.structuredContent).toMatchObject({ total: 0 });
  } finally {
    const ended = await session.close();
    await rm(root, { force: true, recursive: true });
    expect(ended.stderr).toContain("NODE_STDOUT");
    expect(ended.stderr).toContain("CONSOLE_STDOUT");
    expect(ended.stderr).toContain("NATIVE_STDOUT");
    expect(ended.stderr).toContain("CHILD_STDOUT");
    expect(ended.stderr).toContain("SERVER_MARKER=undefined");
    expect(strayLines(ended.stdout)).toEqual([]);
  }
}, 30_000);

it("keeps stdout to protocol frames when stderr is closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-closed-"));
  const { env: homeEnv } = testHome();
  const env = await serverPreload(
    root,
    `process.stdout.write("NODE_STDOUT\\n");
await Bun.write(Bun.stdout, "NATIVE_STDOUT\\n");
Bun.spawnSync(["echo", "CHILD_STDOUT"], { stdout: "inherit" });`,
    homeEnv
  );
  const session = await rawMcpSession(
    "sh",
    [
      "-c",
      'exec "$0" "$@" 2>&-',
      "bun",
      "--no-env-file",
      resolve("src/cli.ts"),
      "mcp",
      "--dry-run",
    ],
    { cwd: root, env }
  );
  try {
    const listed = z
      .object({ result: z.object({ tools: z.array(z.unknown()) }) })
      .parse(await session.request("tools/list"));
    expect(listed.result.tools).toHaveLength(TOOL_NAMES.length);
  } finally {
    const ended = await session.close();
    await rm(root, { force: true, recursive: true });
    expect(ended.code).toBe(0);
    expect(strayLines(ended.stdout)).toEqual([]);
  }
}, 30_000);

it("refuses to serve without the relay's protocol pipe", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-unrelayed-"));
  const home = testHome({ providers: false });
  try {
    const result = spawnSync(
      "bun",
      ["--no-env-file", resolve("src/cli.ts"), "mcp"],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...home.env, MARBLES_MCP_SERVER: "1" },
        input: "",
        stdio: ["pipe", "pipe", "pipe", "ignore"],
        timeout: 15_000,
      }
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "marbles mcp: MARBLES_MCP_SERVER is set but descriptor 3 is not the protocol pipe"
    );
    expect(existsSync(home.layout.state)).toBe(false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 20_000);

it("under --dry-run, never runs a source that throws at load, and still serves the task tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-broken-"));
  const source = join(root, "marbles.ts");
  const home = testHome({ providers: false });
  const { state } = home.layout;
  const ran = join(root, "ran");
  await writeFile(
    source,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(ran)}, "");
console.error("SOURCE_LOADED");
throw new Error("broken source");
`
  );
  const session = await rawMcpSession(
    "bun",
    [
      "--no-env-file",
      resolve("src/cli.ts"),
      "mcp",
      "--source",
      source,
      "--dry-run",
    ],
    { cwd: root, env: home.env }
  );
  const resultSchema = z.object({
    result: z.object({
      isError: z.boolean().optional(),
      structuredContent: z.unknown(),
    }),
  });
  try {
    const created = resultSchema.parse(
      await session.request("tools/call", {
        arguments: {
          operations: [
            { input: { title: "Kept" }, key: "kept", kind: "task.create" },
          ],
        },
        name: "change_tasks",
      })
    );
    expect(created.result.isError).not.toBe(true);
    const listed = resultSchema.parse(
      await session.request("tools/call", TASKS)
    );
    expect(listed.result.structuredContent).toMatchObject({
      items: [{ title: "Kept" }],
      total: 1,
    });
  } finally {
    const ended = await session.close();
    expect(ended.code).toBe(0);
    expect(ended.stderr).not.toContain("SOURCE_LOADED");
    expect(existsSync(ran)).toBe(false);
    expect(existsSync(state)).toBe(false);
    expect(strayLines(ended.stdout)).toEqual([]);
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it("answers from stored state with no Marbles process, and starts nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "mn-"));
  const home = testHome();
  const { state } = home.layout;
  const source = join(root, "marbles.ts");
  const ticked = join(root, "ticked");
  const observed = join(root, "observed");
  await writeFile(
    source,
    `import { appendFileSync } from "node:fs";
import { observe, schedule, step, tasks } from "@foundry.sh/marbles";
observe(tasks, () => appendFileSync(${JSON.stringify(observed)}, "x"));
const tick = step("tick").do(() => appendFileSync(${JSON.stringify(ticked)}, "x"));
schedule(tick).every("1s");`
  );
  const transport = new RecordedStdioTransport({
    args: ["--no-env-file", resolve("src/cli.ts"), "mcp", "--source", source],
    command: "bun",
    cwd: root,
    env: home.env,
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const client = new Client({ name: "marbles-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const created = await client.callTool({
      arguments: {
        operations: [
          { input: { title: "Stored" }, key: "s", kind: "task.create" },
        ],
      },
      name: "change_tasks",
    });
    expect(created.isError, JSON.stringify(created)).not.toBe(true);
    const listed = await client.callTool(TASKS);
    expect(listed.structuredContent).toMatchObject({
      items: [{ title: "Stored" }],
      total: 1,
    });
    const together = await Promise.all([
      client.callTool({
        arguments: {
          operations: [
            { input: { title: "Together" }, key: "t", kind: "task.create" },
          ],
        },
        name: "change_tasks",
      }),
      client.callTool(TASKS),
      client.callTool({
        arguments: { filter: { ready: true }, resource: "tasks" },
        name: "list",
      }),
    ]);
    for (const answered of together) {
      expect(answered.isError, JSON.stringify(answered)).not.toBe(true);
    }
    const after = await client.callTool(TASKS);
    expect(after.structuredContent).toMatchObject({ total: 2 });
    expect(summaries(await client.callTool(WORKSPACES))).toEqual([
      expect.objectContaining({ source, state: "stopped" }),
    ]);
    for (const [name, args] of [
      ["list", { resource: "definitions" }],
      ["list", { resource: "runs" }],
      ["get", { fields: ["agents"], resource: "workspace" }],
      ["enqueue_workflow", { name: "tick" }],
      ["dispatch_agent", { prompt: "Hello" }],
      ["get", { id: "rn-missing", resource: "run" }],
      ["cancel_run", { id: "rn-missing" }],
    ] as const) {
      const refused = await client.callTool({ arguments: args, name });
      expect(refused.isError, name).toBe(true);
      expect(JSON.stringify(refused.content), name).toContain(
        "`marbles daemon attach` in its root hosts it"
      );
    }
    await new Promise((settle) => setTimeout(settle, 1500));
  } catch (error) {
    throw new Error(`MCP session failed:\n${diagnostics}`, { cause: error });
  } finally {
    await client.close();
  }
  try {
    const machine = home.layout;
    expect(daemonAlive(machine)).toBe(false);
    expect(existsSync(machine.socket)).toBe(false);
    expect(existsSync(join(state, "locks", "process"))).toBe(false);
    const [id] = (await readdir(state, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    if (id === undefined) {
      throw new Error("the task change left no workspace state");
    }
    expect((await readWorkspace(state, id))?.hosted).not.toBe(true);
    expect(existsSync(join(state, id, "schedules"))).toBe(false);
    expect(existsSync(ticked)).toBe(false);
    expect(existsSync(observed)).toBe(false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 60_000);

it("starts without a source and serves the stored tasks of every recorded workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "mr-"));
  const home = testHome();
  const { state } = home.layout;
  const here = join(root, "a");
  const other = join(root, "b");
  await mkdir(here);
  await mkdir(other);
  const recorded = workspaceState(state, other);
  await touchWorkspace(state, recorded, null);
  const made = spawnSync(
    "bun",
    ["--no-env-file", resolve("src/cli.ts"), "tasks", "create", "In B"],
    { cwd: other, encoding: "utf8", env: home.env, timeout: 30_000 }
  );
  expect(made.status, made.stderr).toBe(0);
  await rm(other, { force: true, recursive: true });
  const outside = join(root, "outside");
  await mkdir(outside);
  const now = new Date().toISOString();
  await seedWorkspace(state, {
    config: null,
    firstSeen: now,
    hosted: false,
    id: "abc",
    lastSeen: now,
    root: outside,
  });
  await symlink(outside, join(state, "abc"));
  const transport = new RecordedStdioTransport({
    args: ["--no-env-file", resolve("src/cli.ts"), "mcp"],
    command: "bun",
    cwd: here,
    env: home.env,
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const client = new Client({ name: "marbles-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = summaries(await client.callTool(WORKSPACES));
    expect(listed.map((entry) => entry.id)).toContain(recorded.id);
    const fromB = await client.callTool({
      arguments: { resource: "tasks", workspace: recorded.id },
      name: "list",
    });
    expect(fromB.isError, JSON.stringify(fromB)).not.toBe(true);
    expect(fromB.structuredContent).toMatchObject({
      items: [{ title: "In B" }],
      total: 1,
    });
    const intoB = await client.callTool({
      arguments: {
        operations: [
          { input: { title: "Also in B" }, key: "b", kind: "task.create" },
        ],
        workspace: recorded.id,
      },
      name: "change_tasks",
    });
    expect(intoB.isError, JSON.stringify(intoB)).not.toBe(true);
    const created = await client.callTool({
      arguments: {
        operations: [
          { input: { title: "In A" }, key: "a", kind: "task.create" },
        ],
      },
      name: "change_tasks",
    });
    expect(created.isError, JSON.stringify(created)).not.toBe(true);
    for (const id of ["missing", "..", `../${recorded.id}`, state]) {
      const unknown = await client.callTool({
        arguments: { resource: "tasks", workspace: id },
        name: "list",
      });
      expect(unknown.isError, id).toBe(true);
      expect(payload(unknown), id).toMatchObject({
        error: {
          code: "not_found",
          message: expect.stringContaining(
            "list (resource: workspaces) names them"
          ),
        },
      });
    }
    const linked = await client.callTool({
      arguments: {
        operations: [
          { input: { title: "Outside" }, key: "o", kind: "task.create" },
        ],
        workspace: "abc",
      },
      name: "change_tasks",
    });
    expect(linked.isError).toBe(true);
    expect(JSON.stringify(linked.content)).toContain(
      "list (resource: workspaces) names them"
    );
    expect(await readdir(outside)).toEqual([]);
    expect(listed.map((entry) => entry.id)).not.toContain("abc");
    const config = await client.callTool({
      arguments: { resource: "definitions" },
      name: "list",
    });
    expect(config.isError).toBe(true);
    expect(JSON.stringify(config.content)).toContain("no Marbles source at");
  } catch (error) {
    throw new Error(`MCP session failed:\n${diagnostics}`, { cause: error });
  } finally {
    await client.close();
    await rm(root, { force: true, recursive: true });
  }
}, 60_000);

it("refuses its own workspace's tasks when its state links out of the state root", async () => {
  const root = await mkdtemp(join(tmpdir(), "mr-"));
  const home = testHome();
  const { state } = home.layout;
  const here = join(root, "a");
  const outside = join(root, "outside");
  await mkdir(here);
  await mkdir(outside);
  await mkdir(state, { recursive: true });
  const own = workspaceState(state, here);
  await symlink(outside, own.dir);
  const transport = new RecordedStdioTransport({
    args: ["--no-env-file", resolve("src/cli.ts"), "mcp"],
    command: "bun",
    cwd: here,
    env: home.env,
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const client = new Client({ name: "marbles-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    for (const target of [{}, { workspace: own.id }]) {
      const changed = await client.callTool({
        arguments: {
          ...target,
          operations: [
            { input: { title: "Outside" }, key: "o", kind: "task.create" },
          ],
        },
        name: "change_tasks",
      });
      expect(changed.isError, JSON.stringify(target)).toBe(true);
      expect(JSON.stringify(changed.content)).toContain(
        "is not a directory inside"
      );
    }
    expect(await readdir(outside)).toEqual([]);
  } catch (error) {
    throw new Error(`MCP session failed:\n${diagnostics}`, { cause: error });
  } finally {
    await client.close();
    await rm(root, { force: true, recursive: true });
  }
}, 60_000);

it("serves a workspace the Marbles process hosts, by default and by id", async () => {
  const root = await mkdtemp(join(tmpdir(), "mm-"));
  const home = testHome();
  const source = join(root, "marbles.ts");
  const schemaLibrary = createRequire(import.meta.url).resolve("zod");
  await writeFile(
    source,
    `import { step, workflow } from "@foundry.sh/marbles";
import { z } from ${JSON.stringify(schemaLibrary)};
const greet = step("greet").input(z.object({ name: z.string() })).do(({ input }) => ({ greeting: "Hello " + input.name }));
workflow("greeting").input(z.object({ name: z.string() })).do(({ input }) => greet({}, input));`
  );
  const transport = new RecordedStdioTransport({
    args: ["--no-env-file", resolve("src/cli.ts"), "mcp", "--source", source],
    command: "bun",
    cwd: root,
    env: home.env,
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const client = new Client({ name: "marbles-test", version: "1.0.0" });
  try {
    const attached = spawnSync(
      "bun",
      [
        "--no-env-file",
        resolve("src/cli.ts"),
        "daemon",
        "attach",
        "--source",
        source,
      ],
      { cwd: root, encoding: "utf8", env: home.env, timeout: 60_000 }
    );
    expect(attached.status, attached.stderr).toBe(0);
    expect(attached.stdout).toContain("[process] pid");
    expect(daemonAlive(home.layout)).toBe(true);
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual(TOOL_NAMES);
    const hosted = summaries(await client.callTool(WORKSPACES));
    expect(hosted).toHaveLength(1);
    const [workspace] = hosted;
    if (workspace === undefined) {
      throw new Error("no workspace is hosted");
    }
    expect(workspace.source).toBe(source);
    expect(workspace.state).toBe("ready");
    const byDefault = await client.callTool({
      arguments: { resource: "definitions" },
      name: "list",
    });
    expect(byDefault.isError, JSON.stringify(byDefault)).not.toBe(true);
    expect(byDefault.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('"name":"greeting"'),
      }),
    ]);
    const byId = await client.callTool({
      arguments: { resource: "definitions", workspace: workspace.id },
      name: "list",
    });
    expect(byId.isError, JSON.stringify(byId)).not.toBe(true);
    expect(byId.content).toEqual(byDefault.content);
    const run = await client.callTool({
      arguments: {
        input: { name: "Ada" },
        name: "greeting",
        workspace: workspace.id,
      },
      name: "enqueue_workflow",
    });
    expect(run.isError, JSON.stringify(run)).not.toBe(true);
    const { id: runId } = runIdentity(run);
    await vi.waitFor(
      async () => {
        const status = await client.callTool(runOf(runId));
        expect(status.content).toEqual([
          expect.objectContaining({
            text: expect.stringContaining('"status":"completed"'),
          }),
        ]);
        expect(status.content).toEqual([
          expect.objectContaining({
            text: expect.stringContaining('"greeting":"Hello Ada"'),
          }),
        ]);
      },
      { timeout: 15_000 }
    );
    expect(
      payload(
        await client.callTool({
          arguments: { fields: ["status"], resource: "runs" },
          name: "list",
        })
      )
    ).toEqual({ items: [{ id: runId, status: "completed" }], total: 1 });
    const unknown = await client.callTool({
      arguments: { resource: "definitions", workspace: "missing" },
      name: "list",
    });
    expect(unknown.isError).toBe(true);
    const dry = new Client({ name: "marbles-dry", version: "1.0.0" });
    const dryTransport = new RecordedStdioTransport({
      args: [
        "--no-env-file",
        resolve("src/cli.ts"),
        "mcp",
        "--source",
        source,
        "--dry-run",
      ],
      command: "bun",
      cwd: root,
      env: home.env,
      stderr: "pipe",
    });
    try {
      await dry.connect(dryTransport);
      expect(summaries(await dry.callTool(WORKSPACES))).toEqual([
        expect.objectContaining({ id: workspace.id, state: "stopped" }),
      ]);
      const refused = toolAnswer(
        await dry.callTool({
          arguments: { input: { name: "Dry" }, name: "greeting" },
          name: "enqueue_workflow",
        })
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain(DRY_REFUSAL);
      expect(toolAnswer(await dry.callTool(runOf(runId))).isError).toBe(true);
      const created = await dry.callTool({
        arguments: {
          operations: [
            { input: { title: "Dry only" }, key: "d", kind: "task.create" },
          ],
        },
        name: "change_tasks",
      });
      expect(created.isError, JSON.stringify(created)).not.toBe(true);
      expect((await dry.callTool(TASKS)).structuredContent).toMatchObject({
        items: [{ title: "Dry only" }],
        total: 1,
      });
    } finally {
      await dry.close();
    }
    expect(JSON.stringify(await client.callTool(TASKS))).not.toContain(
      "Dry only"
    );
  } catch (error) {
    throw new Error(`MCP session failed:\n${diagnostics}`, { cause: error });
  } finally {
    try {
      await client.close();
      expect(transport.pid).toBeNull();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
}, 120_000);
