import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { layout } from "~/layout";
import { readWorkspace } from "~/lib/state/workspace";
import { daemonAlive } from "~/process/client";
import { version } from "../package.json";
import { stopDaemon } from "./helpers/daemon";
import { rawMcpSession, strayLines } from "./helpers/mcp-stdio";
import { configureProviders } from "./helpers/providers";

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

it("loads source, lists declarations, runs validated input, and dispatches an agent over STDIO", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-"));
  const source = join(root, "marbles.ts");
  const schemaLibrary = createRequire(import.meta.url).resolve("zod");
  await writeFile(
    source,
    `import { agent, step, workflow } from "@foundry.sh/marbles";
import { z } from ${JSON.stringify(schemaLibrary)};
process.stdout.write("source diagnostic\\n");
console.log("source console diagnostic");
agent({ name: "helper", prompt: "You help with tasks." });
const greet = step("greet").input(z.object({ name: z.string() })).do(({ input }) => {
  process.stdout.write("workflow diagnostic\\n");
  return { greeting: "Hello " + input.name };
});
workflow("greeting").input(z.object({ name: z.string() })).do(({ input }) => greet({}, input));`
  );
  configureProviders(join(root, "state"));
  const transport = new StdioClientTransport({
    args: [
      "--no-env-file",
      resolve("src/cli.ts"),
      "mcp",
      "--source",
      source,
      "--state",
      join(root, "state"),
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
    const workspaces = await client.callTool({ name: "list_workspaces" });
    expect(summarySchema.array().parse(payload(workspaces))).toHaveLength(1);
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
    // Under --dry-run the backlog is this server's own, in memory: a change
    // reads back here and writes nothing under the state root.
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
    expect(
      existsSync(join(root, "state")) &&
        (await readdir(join(root, "state"), { recursive: true })).some(
          (entry) => entry.endsWith("tasks.json")
        )
    ).toBe(false);
    expect(diagnostics).toContain("source diagnostic");
    expect(diagnostics).toContain("source console diagnostic");
    expect(diagnostics).toContain("workflow diagnostic");
  } catch (error) {
    throw new Error(`MCP session failed:\n${diagnostics}`, { cause: error });
  } finally {
    await client.close();
    expect(transport.pid).toBeNull();
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it("keeps a dry-run model turn's log, Bun's own stdout, and a child's off the protocol stream", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-dry-"));
  const source = join(root, "marbles.ts");
  await writeFile(
    source,
    `import { agent } from "@foundry.sh/marbles";
await Bun.write(Bun.stdout, "NATIVE_STDOUT\\n");
Bun.spawnSync(["echo", "CHILD_STDOUT"], { stdout: "inherit" });
agent({ name: "helper", prompt: "You help." });`
  );
  configureProviders(join(root, "state"));
  const session = await rawMcpSession(
    "bun",
    [
      "--no-env-file",
      resolve("src/cli.ts"),
      "mcp",
      "--source",
      source,
      "--state",
      join(root, "state"),
      "--dry-run",
    ],
    { cwd: root }
  );
  try {
    const dispatched = z.object({ result: z.unknown() }).parse(
      await session.request("tools/call", {
        arguments: { agent: "helper", prompt: "Hello agent" },
        name: "dispatch_agent",
      })
    );
    const { runId } = runIdentity(dispatched.result);
    await vi.waitFor(async () => {
      const status = z.object({ result: z.unknown() }).parse(
        await session.request("tools/call", {
          arguments: { runId },
          name: "get_run",
        })
      );
      expect(payload(status.result)).toMatchObject({ status: "completed" });
    });
  } finally {
    const ended = await session.close();
    await rm(root, { force: true, recursive: true });
    // The turn's model log is a diagnostic: stderr has it, stdout does not.
    expect(ended.stderr).toContain("models.inference");
    expect(ended.stderr).toContain("NATIVE_STDOUT");
    expect(ended.stderr).toContain("CHILD_STDOUT");
    expect(strayLines(ended.stdout)).toEqual([]);
  }
}, 30_000);

it("reports a source that fails to load on stderr, never on the protocol stream", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-broken-"));
  const source = join(root, "marbles.ts");
  try {
    await writeFile(
      source,
      'process.stdout.write("before the failure\\n");\nthrow new Error("broken source");\n'
    );
    const result = spawnSync(
      "bun",
      [
        "--no-env-file",
        resolve("src/cli.ts"),
        "mcp",
        "--source",
        source,
        "--dry-run",
      ],
      { cwd: root, encoding: "utf8", input: "", timeout: 15_000 }
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("before the failure");
    expect(result.stderr).toContain(
      `marbles mcp: could not open the workspace for "${source}": broken source`
    );
    expect(result.stderr).toContain(`${source}:2`);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 20_000);

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
