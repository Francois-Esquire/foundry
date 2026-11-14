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
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { layout } from "~/layout";
import { readWorkspace, workspaceState } from "~/lib/state/workspace";
import { daemonAlive } from "~/process/client";
import { version } from "../package.json";
import { stopDaemon } from "./helpers/daemon";
import { rawMcpSession, serverPreload, strayLines } from "./helpers/mcp-stdio";

const TOOL_NAMES = [
  "list_workspaces",
  "list_config",
  "dispatch_workflow",
  "dispatch_agent",
  "get_run",
  "cancel_run",
  "list_tasks",
  "ready_tasks",
  "get_task",
  "task_dependencies",
  "change_tasks",
];

/** The one text block a tool result carries, parsed. */
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
  return z.object({ runId: z.string() }).parse(payload(value));
}

const summarySchema = z.object({
  config: z.string().nullable(),
  id: z.string(),
  root: z.string(),
  state: z.string(),
});

it("dispatches workflows and agents through the MCP tools, over a workspace a dry-run host serves", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-"));
  const source = join(root, "marbles.ts");
  const schemaLibrary = createRequire(import.meta.url).resolve("zod");
  await writeFile(
    source,
    `import { agent, step, workflow } from "@foundry.sh/marbles";
import { z } from ${JSON.stringify(schemaLibrary)};
agent({ name: "helper", prompt: "You help with tasks." });
const greet = step("greet").input(z.object({ name: z.string() })).do(({ input }) => {
  console.error("workflow diagnostic");
  return { greeting: "Hello " + input.name };
});
workflow("greeting").input(z.object({ name: z.string() })).do(({ input }) => greet({}, input));`
  );
  // `marbles mcp` hosts nothing, so the tools are served over a host here.
  const transport = new StdioClientTransport({
    args: ["--no-env-file", resolve("test/helpers/dry-mcp-host.ts"), source],
    command: "bun",
    cwd: root,
    env: process.env as Record<string, string>,
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
    // Every workspace tool advertises the id it can be pointed at.
    for (const tool of listed.tools) {
      if (tool.name !== "list_workspaces") {
        expect(tool.inputSchema.properties, tool.name).toHaveProperty(
          "workspace"
        );
      }
    }
    // A tool with an input schema takes an arguments object, even an empty one.
    const config = await client.callTool({
      arguments: {},
      name: "list_config",
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
    const run = await client.callTool({
      arguments: { input: { name: "Ada" }, name: "greeting" },
      name: "dispatch_workflow",
    });
    const workflow = runIdentity(run);
    await vi.waitFor(async () => {
      const status = await client.callTool({
        arguments: { runId: workflow.runId },
        name: "get_run",
      });
      expect(status.content).toEqual([
        expect.objectContaining({
          text: expect.stringContaining('"greeting":"Hello Ada"'),
        }),
      ]);
    });
    const invalid = await client.callTool({
      arguments: { input: { name: 42 }, name: "greet" },
      name: "dispatch_workflow",
    });
    expect(invalid.isError).toBe(true);
    const missing = await client.callTool({
      arguments: { name: "missing" },
      name: "dispatch_workflow",
    });
    expect(missing.isError).toBe(true);
    const dispatched = await client.callTool({
      arguments: { agent: "helper", maxTurns: 3, prompt: "Hello agent" },
      name: "dispatch_agent",
    });
    expect(dispatched.isError, JSON.stringify(dispatched)).not.toBe(true);
    const job = runIdentity(dispatched);
    await vi.waitFor(async () => {
      const status = await client.callTool({
        arguments: { runId: job.runId },
        name: "get_run",
      });
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
    // The session a dispatch returns continues as given, identity included.
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
      const status = await client.callTool({
        arguments: { runId: followUp.runId },
        name: "get_run",
      });
      expect(payload(status)).toMatchObject({
        session: { id: session.id, instance: session.instance },
        status: "completed",
        text: expect.stringContaining("Hello again"),
      });
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
    const missingJob = await client.callTool({
      arguments: { runId: "missing" },
      name: "get_run",
    });
    expect(missingJob.isError).toBe(true);
    const cancelled = await client.callTool({
      arguments: { runId: job.runId },
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

/** What a tool call answers, and whether it was refused. */
function toolAnswer(value: unknown): { isError: boolean; text: string } {
  const parsed = CallToolResultSchema.parse(value);
  const [block] = parsed.content;
  return {
    isError: parsed.isError === true,
    text: block?.type === "text" ? block.text : "",
  };
}

const DRY_REFUSAL =
  "A dry run of a workflow goes through `marbles roll --dry-run`.";

it("under --dry-run, loads no source, keeps tasks in memory, and refuses what needs a running instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-dry-"));
  const source = join(root, "marbles.ts");
  const state = join(root, "state");
  await writeFile(
    source,
    `import { step, workflow } from "@foundry.sh/marbles";
console.error("SOURCE_LOADED");
workflow("greeting").do(() => step("greet").do(() => "hello")({}));`
  );
  const transport = new StdioClientTransport({
    args: [
      "--no-env-file",
      resolve("src/cli.ts"),
      "mcp",
      "--source",
      source,
      "--state",
      state,
      "--dry-run",
    ],
    command: "bun",
    cwd: root,
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
    // Its own workspace only, as stored state names it: nothing hosts it.
    const workspaces = summarySchema
      .array()
      .parse(payload(await client.callTool({ name: "list_workspaces" })));
    expect(workspaces).toEqual([
      expect.objectContaining({ config: source, state: "stopped" }),
    ]);
    for (const [name, args] of [
      ["list_config", {}],
      ["dispatch_workflow", { name: "greeting" }],
      ["dispatch_agent", { prompt: "Hello" }],
      ["get_run", { runId: "any" }],
      ["cancel_run", { runId: "any" }],
    ] as const) {
      const refused = toolAnswer(
        await client.callTool({ arguments: args, name })
      );
      expect(refused.isError, name).toBe(true);
      expect(refused.text, name).toContain("marbles attach");
      expect(refused.text, name).toContain(DRY_REFUSAL);
    }
    // The backlog is this server's own, in memory: a change reads back here.
    const created = await client.callTool({
      arguments: {
        operations: [
          { input: { title: "Dry" }, key: "dry", kind: "task.create" },
        ],
      },
      name: "change_tasks",
    });
    expect(created.isError, JSON.stringify(created)).not.toBe(true);
    const tasks = await client.callTool({ arguments: {}, name: "list_tasks" });
    expect(tasks.structuredContent).toMatchObject({
      items: [{ title: "Dry" }],
      total: 1,
    });
    const elsewhere = toolAnswer(
      await client.callTool({
        arguments: { workspace: "other" },
        name: "list_tasks",
      })
    );
    expect(elsewhere.isError).toBe(true);
    expect(elsewhere.text).toContain("is available under --dry-run");
  } catch (error) {
    throw new Error(`MCP session failed:\n${diagnostics}`, { cause: error });
  } finally {
    await client.close();
    expect(transport.pid).toBeNull();
    // Nothing ran the source, and nothing was written: not even a record.
    expect(diagnostics).not.toContain("SOURCE_LOADED");
    expect(existsSync(state)).toBe(false);
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it("keeps what the server process writes to stdout, natively or through a child, off the protocol stream", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-stdout-"));
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
});`
  );
  const session = await rawMcpSession(
    "bun",
    [
      "--no-env-file",
      resolve("src/cli.ts"),
      "mcp",
      "--state",
      join(root, "state"),
      "--dry-run",
    ],
    { cwd: root, env }
  );
  try {
    const listed = z
      .object({ result: z.object({ structuredContent: z.unknown() }) })
      .parse(
        await session.request("tools/call", {
          arguments: {},
          name: "list_tasks",
        })
      );
    expect(listed.result.structuredContent).toMatchObject({ total: 0 });
  } finally {
    const ended = await session.close();
    await rm(root, { force: true, recursive: true });
    expect(ended.stderr).toContain("NODE_STDOUT");
    expect(ended.stderr).toContain("CONSOLE_STDOUT");
    expect(ended.stderr).toContain("NATIVE_STDOUT");
    expect(ended.stderr).toContain("CHILD_STDOUT");
    // The server took its marker out of the environment.
    expect(ended.stderr).toContain("SERVER_MARKER=undefined");
    expect(strayLines(ended.stdout)).toEqual([]);
  }
}, 30_000);

it("keeps stdout to protocol frames when stderr is closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-closed-"));
  const env = await serverPreload(
    root,
    `process.stdout.write("NODE_STDOUT\\n");
await Bun.write(Bun.stdout, "NATIVE_STDOUT\\n");
Bun.spawnSync(["echo", "CHILD_STDOUT"], { stdout: "inherit" });`
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
      "--state",
      join(root, "state"),
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
  try {
    const result = spawnSync(
      "bun",
      [
        "--no-env-file",
        resolve("src/cli.ts"),
        "mcp",
        "--state",
        join(root, "state"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, MARBLES_MCP_SERVER: "1" },
        input: "",
        // Descriptor 3 is otherwise whatever this test process passes on.
        stdio: ["pipe", "pipe", "pipe", "ignore"],
        timeout: 15_000,
      }
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "marbles mcp: MARBLES_MCP_SERVER is set but descriptor 3 is not the protocol pipe"
    );
    expect(existsSync(join(root, "state"))).toBe(false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 20_000);

it("under --dry-run, never runs a source that throws at load, and still serves the task tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-broken-"));
  const source = join(root, "marbles.ts");
  const state = join(root, "state");
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
      "--state",
      state,
      "--dry-run",
    ],
    { cwd: root }
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
      await session.request("tools/call", {
        arguments: {},
        name: "list_tasks",
      })
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
  // Short on purpose: a socket path under the state root is limited.
  const root = await mkdtemp(join(tmpdir(), "mn-"));
  const state = join(root, "s");
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
  const transport = new StdioClientTransport({
    args: [
      "--no-env-file",
      resolve("src/cli.ts"),
      "mcp",
      "--source",
      source,
      "--state",
      state,
    ],
    command: "bun",
    cwd: root,
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const client = new Client({ name: "marbles-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    // The task tools read and write the stored backlog.
    const created = await client.callTool({
      arguments: {
        operations: [
          { input: { title: "Stored" }, key: "s", kind: "task.create" },
        ],
      },
      name: "change_tasks",
    });
    expect(created.isError, JSON.stringify(created)).not.toBe(true);
    const listed = await client.callTool({ arguments: {}, name: "list_tasks" });
    expect(listed.structuredContent).toMatchObject({
      items: [{ title: "Stored" }],
      total: 1,
    });
    // Calls a client sends together each open the stored tasks in turn.
    const together = await Promise.all([
      client.callTool({
        arguments: {
          operations: [
            { input: { title: "Together" }, key: "t", kind: "task.create" },
          ],
        },
        name: "change_tasks",
      }),
      client.callTool({ arguments: {}, name: "list_tasks" }),
      client.callTool({ arguments: {}, name: "ready_tasks" }),
    ]);
    for (const answered of together) {
      expect(answered.isError, JSON.stringify(answered)).not.toBe(true);
    }
    const after = await client.callTool({ arguments: {}, name: "list_tasks" });
    expect(after.structuredContent).toMatchObject({ total: 2 });
    expect(
      summarySchema
        .array()
        .parse(payload(await client.callTool({ name: "list_workspaces" })))
    ).toEqual([expect.objectContaining({ config: source, state: "stopped" })]);
    // Everything that runs, or reads a run, needs a host, and names it.
    for (const [name, args] of [
      ["list_config", {}],
      ["dispatch_workflow", { name: "tick" }],
      ["dispatch_agent", { prompt: "Hello" }],
      ["get_run", { runId: "rn-missing" }],
      ["cancel_run", { runId: "rn-missing" }],
    ] as const) {
      const refused = await client.callTool({ arguments: args, name });
      expect(refused.isError, name).toBe(true);
      expect(JSON.stringify(refused.content), name).toContain(
        "`marbles attach` in its root hosts it"
      );
    }
    // Long enough for a one-second schedule to have fired, had anything run it.
    await new Promise((settle) => setTimeout(settle, 1500));
  } catch (error) {
    throw new Error(`MCP session failed:\n${diagnostics}`, { cause: error });
  } finally {
    await client.close();
  }
  try {
    const machine = layout({ state });
    expect(daemonAlive(machine)).toBe(false);
    expect(existsSync(machine.socket)).toBe(false);
    expect(existsSync(join(state, "locks", "process"))).toBe(false);
    const [id] = await readdir(state);
    if (id === undefined) {
      throw new Error("the task change left no workspace state");
    }
    expect(readWorkspace(join(state, id))?.hosted).not.toBe(true);
    expect(existsSync(join(state, id, "schedules"))).toBe(false);
    // No source ran here: no schedule ticked and no observer saw the change.
    expect(existsSync(ticked)).toBe(false);
    expect(existsSync(observed)).toBe(false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 60_000);

it("starts without a source and serves the stored tasks of every recorded workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "mr-"));
  const state = join(root, "s");
  const here = join(root, "a");
  const other = join(root, "b");
  await mkdir(here);
  await mkdir(other);
  // B is recorded, stopped, and has a task the CLI wrote without a process.
  const recorded = workspaceState(state, other);
  recorded.touch(null);
  const made = spawnSync(
    "bun",
    [
      "--no-env-file",
      resolve("src/cli.ts"),
      "tasks",
      "create",
      "In B",
      "--state",
      state,
    ],
    { cwd: other, encoding: "utf8", timeout: 30_000 }
  );
  expect(made.status, made.stderr).toBe(0);
  // Its checkout is gone; its stored tasks are not.
  await rm(other, { force: true, recursive: true });
  // A symlinked entry points out of the state root, at a matching record.
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(
    join(outside, "workspace.json"),
    JSON.stringify({ id: "abc", root: outside })
  );
  await symlink(outside, join(state, "abc"));
  const transport = new StdioClientTransport({
    args: ["--no-env-file", resolve("src/cli.ts"), "mcp", "--state", state],
    command: "bun",
    cwd: here,
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const client = new Client({ name: "marbles-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = summarySchema
      .array()
      .parse(payload(await client.callTool({ name: "list_workspaces" })));
    expect(listed.map((entry) => entry.id)).toContain(recorded.id);
    const fromB = await client.callTool({
      arguments: { workspace: recorded.id },
      name: "list_tasks",
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
    // This workspace has no source, yet its tasks are stored all the same.
    const created = await client.callTool({
      arguments: {
        operations: [
          { input: { title: "In A" }, key: "a", kind: "task.create" },
        ],
      },
      name: "change_tasks",
    });
    expect(created.isError, JSON.stringify(created)).not.toBe(true);
    // An id names a directory listed under the state root, nothing else.
    for (const id of ["missing", "..", `../${recorded.id}`, state]) {
      const unknown = await client.callTool({
        arguments: { workspace: id },
        name: "list_tasks",
      });
      expect(unknown.isError, id).toBe(true);
      expect(JSON.stringify(unknown.content), id).toContain(
        "list_workspaces names them"
      );
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
      "list_workspaces names them"
    );
    expect(await readdir(outside)).toEqual(["workspace.json"]);
    expect(listed.map((entry) => entry.id)).not.toContain("abc");
    const config = await client.callTool({
      arguments: {},
      name: "list_config",
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
  const state = join(root, "s");
  const here = join(root, "a");
  const outside = join(root, "outside");
  await mkdir(here);
  await mkdir(outside);
  await mkdir(state);
  const own = workspaceState(state, here);
  await symlink(outside, own.dir);
  const transport = new StdioClientTransport({
    args: ["--no-env-file", resolve("src/cli.ts"), "mcp", "--state", state],
    command: "bun",
    cwd: here,
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const client = new Client({ name: "marbles-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    // The default target, then the same workspace named by its id.
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
  // Short on purpose: the state root holds a Unix socket, whose path is
  // limited to about a hundred bytes.
  const root = await mkdtemp(join(tmpdir(), "mm-"));
  const state = join(root, "s");
  const source = join(root, "marbles.ts");
  const schemaLibrary = createRequire(import.meta.url).resolve("zod");
  await writeFile(
    source,
    `import { step, workflow } from "@foundry.sh/marbles";
import { z } from ${JSON.stringify(schemaLibrary)};
const greet = step("greet").input(z.object({ name: z.string() })).do(({ input }) => ({ greeting: "Hello " + input.name }));
workflow("greeting").input(z.object({ name: z.string() })).do(({ input }) => greet({}, input));`
  );
  const transport = new StdioClientTransport({
    args: [
      "--no-env-file",
      resolve("src/cli.ts"),
      "mcp",
      "--source",
      source,
      "--state",
      state,
    ],
    command: "bun",
    cwd: root,
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const client = new Client({ name: "marbles-test", version: "1.0.0" });
  try {
    // The CLI starts the Marbles process and hosts the workspace; the server
    // only joins it.
    const attached = spawnSync(
      "bun",
      [
        "--no-env-file",
        resolve("src/cli.ts"),
        "attach",
        "--source",
        source,
        "--state",
        state,
      ],
      { cwd: root, encoding: "utf8", timeout: 60_000 }
    );
    expect(attached.status, attached.stderr).toBe(0);
    expect(attached.stdout).toContain("[process] pid");
    expect(daemonAlive(layout({ state }))).toBe(true);
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual(TOOL_NAMES);
    const hosted = summarySchema
      .array()
      .parse(payload(await client.callTool({ name: "list_workspaces" })));
    expect(hosted).toHaveLength(1);
    const [workspace] = hosted;
    if (workspace === undefined) {
      throw new Error("no workspace is hosted");
    }
    expect(workspace.config).toBe(source);
    expect(workspace.state).toBe("ready");
    const byDefault = await client.callTool({
      arguments: {},
      name: "list_config",
    });
    expect(byDefault.isError, JSON.stringify(byDefault)).not.toBe(true);
    expect(byDefault.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('"name":"greeting"'),
      }),
    ]);
    const byId = await client.callTool({
      arguments: { workspace: workspace.id },
      name: "list_config",
    });
    expect(byId.isError, JSON.stringify(byId)).not.toBe(true);
    expect(byId.content).toEqual(byDefault.content);
    const run = await client.callTool({
      arguments: {
        input: { name: "Ada" },
        name: "greeting",
        workspace: workspace.id,
      },
      name: "dispatch_workflow",
    });
    expect(run.isError, JSON.stringify(run)).not.toBe(true);
    const { runId } = runIdentity(run);
    await vi.waitFor(
      async () => {
        const status = await client.callTool({
          arguments: { runId },
          name: "get_run",
        });
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
    const unknown = await client.callTool({
      arguments: { workspace: "missing" },
      name: "list_config",
    });
    expect(unknown.isError).toBe(true);
    // Under --dry-run the server drives nothing, though a worker hosts the
    // workspace: a dry dispatch never starts a real run.
    const dry = new Client({ name: "marbles-dry", version: "1.0.0" });
    const dryTransport = new StdioClientTransport({
      args: [
        "--no-env-file",
        resolve("src/cli.ts"),
        "mcp",
        "--source",
        source,
        "--state",
        state,
        "--dry-run",
      ],
      command: "bun",
      cwd: root,
      stderr: "pipe",
    });
    try {
      await dry.connect(dryTransport);
      expect(
        summarySchema
          .array()
          .parse(payload(await dry.callTool({ name: "list_workspaces" })))
      ).toEqual([
        expect.objectContaining({ id: workspace.id, state: "stopped" }),
      ]);
      const refused = toolAnswer(
        await dry.callTool({
          arguments: { input: { name: "Dry" }, name: "greeting" },
          name: "dispatch_workflow",
        })
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain(DRY_REFUSAL);
      expect(
        toolAnswer(
          await dry.callTool({ arguments: { runId }, name: "get_run" })
        ).isError
      ).toBe(true);
    } finally {
      await dry.close();
    }
  } catch (error) {
    throw new Error(`MCP session failed:\n${diagnostics}`, { cause: error });
  } finally {
    try {
      await client.close();
      expect(transport.pid).toBeNull();
    } finally {
      try {
        // The daemon outlives the server; the test stops it.
        await stopDaemon(state);
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    }
  }
}, 120_000);
