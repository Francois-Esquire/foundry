import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { cliArgs } from "./helpers/cli";

const item = z.object({
  delivered: z.array(z.string()),
  payload: z.object({
    tasks: z.array(
      z.object({ after: z.object({ tags: z.array(z.string()) }).loose() })
    ),
  }),
});
const records = z.object({
  items: z.array(item),
  tasks: z.array(z.object({ tags: z.array(z.string()), title: z.string() })),
});

const HELD = /^marbles: the tasks of this workspace .* are in use by /;

function text(value: unknown): string {
  const [block] = CallToolResultSchema.parse(value).content;
  if (block?.type !== "text") {
    throw new Error("the result carried no text");
  }
  return block.text;
}

/** The one workspace dir under the state root, once something wrote there. */
async function recordsFile(state: string): Promise<string> {
  const [workspace] = await readdir(state);
  if (workspace === undefined) {
    throw new Error("no workspace state yet");
  }
  return join(state, workspace, "tasks.json");
}

it("serves the workspace's tasks: a CLI change kept for later observers, tags, delivery, reads that change nothing, one owner, and kept after exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-tasks-"));
  const state = join(root, "state");
  const source = join(root, "marbles.ts");
  const seen = join(root, "seen.jsonl");
  await writeFile(
    source,
    `import { appendFileSync } from "node:fs";
import { observe, step, tasks } from "@foundry.sh/marbles";
observe(tasks, (payload) => {
  appendFileSync(${JSON.stringify(seen)}, JSON.stringify(payload) + "\\n");
});
// Stays undelivered, so the item stays in the stream.
observe(tasks, () => {
  throw new Error("not yet");
});
step("titles").do(async () => (await tasks.list()).items.map((task) => task.title));`
  );
  const transport = new StdioClientTransport({
    args: [resolve("src/mcp/stdio.ts"), "--source", source, "--state", state],
    command: "bun",
    cwd: root,
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const client = new Client({ name: "tasks-stdio", version: "1.0.0" });
  const cli = (...argv: readonly string[]) =>
    spawnSync(
      "bun",
      cliArgs("tasks", ...argv, "--source", source, "--state", state),
      { cwd: root, encoding: "utf8", timeout: 15_000 }
    );
  // A CLI change, made where no source runs and nothing observes, is kept
  // undelivered for the observers a later host declares.
  const fromCli = cli("create", "From CLI", "--tag", "cli", "--json");
  expect(fromCli.status, fromCli.stderr).toBe(0);
  const path = await recordsFile(state);
  const kept = records.parse(JSON.parse(await readFile(path, "utf8")));
  expect(kept.items).toEqual([
    expect.objectContaining({
      delivered: [],
      payload: expect.objectContaining({
        tasks: [
          expect.objectContaining({
            after: expect.objectContaining({ tags: ["cli"] }),
          }),
        ],
      }),
    }),
  ]);
  try {
    await client.connect(transport);
    const created = await client.callTool({
      arguments: {
        operations: [
          {
            input: { tags: ["review", "api"], title: "From MCP" },
            key: "mcp",
            kind: "task.create",
          },
        ],
      },
      name: "change_tasks",
    });
    expect(created.isError, JSON.stringify(created)).not.toBe(true);
    expect(created.structuredContent).toMatchObject({
      tasks: [{ tags: ["review", "api"], title: "From MCP" }],
    });

    // The builtin `tasks` a step reads is the same workspace store.
    const run = z.object({ runId: z.string() }).parse(
      JSON.parse(
        text(
          await client.callTool({
            arguments: { name: "titles" },
            name: "dispatch_workflow",
          })
        )
      )
    );
    await vi.waitFor(async () => {
      const status = text(
        await client.callTool({
          arguments: { runId: run.runId },
          name: "get_run",
        })
      );
      expect(status).toContain('"status":"completed"');
      expect(status).toContain('["From CLI","From MCP"]');
    });

    // The MCP host delivers the CLI's change and its own, oldest first: one
    // observer completes each, the other keeps failing.
    await vi.waitFor(
      async () => {
        expect(existsSync(seen)).toBe(true);
        const stored = records.parse(JSON.parse(await readFile(path, "utf8")));
        expect(stored.items.map((entry) => entry.delivered.length)).toEqual([
          1, 1,
        ]);
      },
      { timeout: 10_000 }
    );
    const payloads = (await readFile(seen, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(payloads).toMatchObject([
      { tasks: [{ after: { tags: ["cli"] }, before: null }] },
      {
        kind: "tasks.changed",
        tasks: [{ after: { tags: ["review", "api"] }, before: null }],
      },
    ]);

    // Reads change nothing on disk, delivered hashes included.
    const before = await readFile(path, "utf8");
    const listed = await client.callTool({
      arguments: { tags: { all: ["review"], any: ["api", "x"] } },
      name: "list_tasks",
    });
    expect(listed.isError, JSON.stringify(listed)).not.toBe(true);
    expect(listed.structuredContent).toMatchObject({
      items: [{ tags: ["review", "api"], title: "From MCP" }],
      total: 1,
    });
    const ready = await client.callTool({
      arguments: { tags: { all: ["missing"] } },
      name: "ready_tasks",
    });
    expect(ready.structuredContent).toEqual({ items: [], total: 0 });
    expect(records.parse(JSON.parse(before)).tasks).toHaveLength(2);
    expect(await readFile(path, "utf8")).toBe(before);

    // Another process is refused the tasks while this server owns them.
    const held = cli("list", "--json");
    expect(held.status, held.stderr).toBe(1);
    expect(held.stdout).toBe("");
    expect(held.stderr).toMatch(HELD);
  } catch (error) {
    throw new Error(`MCP tasks session failed:\n${diagnostics}`, {
      cause: error,
    });
  } finally {
    await client.close();
  }
  try {
    // Closing the server gives them up; the next process reads what it wrote.
    const after = cli("list", "--tag", "review", "--json");
    expect(after.status, after.stderr).toBe(0);
    expect(JSON.parse(after.stdout)).toMatchObject({
      items: [{ tags: ["review", "api"], title: "From MCP" }],
      total: 1,
    });
    // CLI reads leave the records, delivered hashes included, as they were.
    const settled = await readFile(path, "utf8");
    const { items } = records.parse(JSON.parse(settled));
    expect(items.map((entry) => entry.delivered.length)).toEqual([1, 1]);
    const [first] = JSON.parse(after.stdout).items;
    for (const argv of [
      ["list"],
      ["ready", "--any-tag", "cli"],
      ["get", first.id, "--depth", "1"],
      ["deps", first.id],
    ]) {
      const read = cli(...argv, "--json");
      expect(read.status, `${argv.join(" ")}: ${read.stderr}`).toBe(0);
    }
    expect(await readFile(path, "utf8")).toBe(settled);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 45_000);
