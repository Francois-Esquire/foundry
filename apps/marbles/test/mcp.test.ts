import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { version } from "../package.json";
import { cliArgs } from "./helpers/cli";

function runIdentity(value: unknown) {
  const content = CallToolResultSchema.parse(value).content.find(
    (block) => block.type === "text"
  );
  if (content?.type !== "text") {
    throw new Error("run returned no text");
  }
  return z.object({ runId: z.string() }).parse(JSON.parse(content.text));
}

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
  const transport = new StdioClientTransport({
    args: [
      resolve("src/mcp/stdio.ts"),
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
    expect(listed.tools.map(({ name }) => name)).toEqual([
      "list_config",
      "dispatch_workflow",
      "dispatch_agent",
      "get_run",
      "cancel_run",
    ]);
    const config = await client.callTool({ name: "list_config" });
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

it("exits cleanly when the client closes stdin", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-close-"));
  const source = join(root, "marbles.ts");
  try {
    await writeFile(source, "export {};");
    const stdout = execFileSync(
      "bun",
      [resolve("src/mcp/stdio.ts"), "--source", source, "--dry-run"],
      {
        cwd: root,
        encoding: "utf8",
        input: "",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15_000,
      }
    );
    expect(stdout).toBe("");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 20_000);

it("returns a workflow runId immediately and lets a separate CLI watch live output", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-watch-"));
  const state = join(root, "state");
  const gate = join(root, "release");
  const loaded = join(root, "loaded");
  const source = join(root, "marbles.ts");
  await writeFile(
    source,
    `import { step } from "@foundry.sh/marbles";
import { existsSync, appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(loaded)}, "loaded\\n");
step("held").do(async ({ stream, signal }) => {
  stream.write("early 🌿");
  while (!existsSync(${JSON.stringify(gate)})) {
    await new Promise((done) => setTimeout(done, 20));
    signal.throwIfAborted();
  }
  stream.write(" late");
  return { done: true };
});
step("fail").do(({ stream }) => { stream.write("before failure"); throw new Error("expected failure"); });
step("wait").do(async ({ stream, signal }) => {
  stream.write("waiting");
  while (!signal.aborted) { await new Promise((done) => setTimeout(done, 20)); }
  signal.throwIfAborted();
});`
  );
  const transport = new StdioClientTransport({
    args: [
      resolve("src/mcp/stdio.ts"),
      "--source",
      source,
      "--state",
      state,
      "--harness",
      "claude-code",
    ],
    command: "bun",
    cwd: root,
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const client = new Client({ name: "watch-test", version: "1.0.0" });
  let watcher: ReturnType<typeof spawn> | undefined;
  try {
    await client.connect(transport);
    const started = runIdentity(
      await client.callTool({
        arguments: { name: "held" },
        name: "dispatch_workflow",
      })
    );
    watcher = spawn("bun", cliArgs("watch", started.runId, "--state", state), {
      cwd: tmpdir(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((done, reject) => {
      watcher?.once("exit", done);
      watcher?.once("error", reject);
    });
    let stdout = "";
    watcher.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    await vi.waitFor(() => expect(stdout).toContain("early 🌿"), {
      timeout: 10_000,
    });
    const status = await client.callTool({
      arguments: { runId: started.runId },
      name: "get_run",
    });
    expect(status.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('"status":"running"'),
      }),
    ]);
    await writeFile(gate, "done");
    expect(await exited).toBe(0);
    expect(stdout).toContain("early 🌿 late");
    expect(stdout).toContain(`[run] ${started.runId} completed`);
    const replay = execFileSync(
      "bun",
      cliArgs("watch", started.runId, "--state", state),
      {
        cwd: tmpdir(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      }
    );
    expect(replay).toBe(stdout);
    expect(await readFile(loaded, "utf8")).toBe("loaded\n");
    const failed = runIdentity(
      await client.callTool({
        arguments: { name: "fail" },
        name: "dispatch_workflow",
      })
    );
    let failure: unknown;
    try {
      execFileSync("bun", cliArgs("watch", failed.runId, "--state", state), {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      status: 1,
      stdout: expect.stringContaining("expected failure"),
    });
    const cancelled = runIdentity(
      await client.callTool({
        arguments: { name: "wait" },
        name: "dispatch_workflow",
      })
    );
    await client.callTool({
      arguments: { runId: cancelled.runId },
      name: "cancel_run",
    });
    let cancellation: unknown;
    try {
      execFileSync("bun", cliArgs("watch", cancelled.runId, "--state", state), {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      });
    } catch (error) {
      cancellation = error;
    }
    expect(cancellation).toMatchObject({
      status: 1,
      stdout: expect.stringContaining(`[run] ${cancelled.runId} cancelled`),
    });
  } catch (error) {
    throw new Error(`MCP watch failed:\n${diagnostics}`, { cause: error });
  } finally {
    watcher?.kill();
    await client.close();
    await rm(root, { force: true, recursive: true });
  }
}, 45_000);
