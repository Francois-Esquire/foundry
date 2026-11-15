import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tasks as taskRows } from "@foundry/tasks/store/tables";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { readDatabase } from "~/database/open";
import {
  marblesTaskChangeDeliveries,
  marblesTaskChanges,
} from "~/database/tables";
import { stateDatabase } from "~/layout";
import { cliArgs } from "./helpers/cli";
import { stopDaemon } from "./helpers/daemon";
import { testHome } from "./helpers/home";

const change = z.object({
  delivered: z.number(),
  payload: z.object({
    tasks: z.array(
      z.object({ after: z.object({ tags: z.array(z.string()) }).loose() })
    ),
  }),
});
const records = z.object({
  changes: z.array(change),
  tasks: z.array(z.object({ tags: z.array(z.string()), title: z.string() })),
});

/**
 * Every task and recorded change under the state root, with how many
 * observers completed each change, read as a reader does.
 */
async function stored(state: string): Promise<z.infer<typeof records>> {
  const read = await readDatabase(stateDatabase(state), async (database) => {
    const changes = await database
      .select()
      .from(marblesTaskChanges)
      .orderBy(marblesTaskChanges.position);
    const deliveries = await database
      .select()
      .from(marblesTaskChangeDeliveries);
    const tasks = await database
      .select({ tags: taskRows.tags, title: taskRows.title })
      .from(taskRows)
      .orderBy(taskRows.position);
    return {
      changes: changes.map((row) => ({
        delivered: deliveries.filter(
          (delivery) =>
            delivery.scope === row.scope && delivery.changeId === row.id
        ).length,
        payload: row.payload,
      })),
      tasks,
    };
  });
  return records.parse(read);
}

/** The database's files, byte for byte, read where no connection has them open. */
async function files(state: string) {
  const names = (await readdir(state)).filter((name) =>
    name.startsWith("marbles.db")
  );
  return await Promise.all(
    names.sort().map(async (name) => {
      const path = join(state, name);
      const { mtimeMs, size } = await stat(path);
      return { bytes: await readFile(path, "base64"), mtimeMs, name, size };
    })
  );
}

const NOT_FOUND = "marbles: [tasks] Task nope not found (not_found)\n";

function text(value: unknown): string {
  const [block] = CallToolResultSchema.parse(value).content;
  if (block?.type !== "text") {
    throw new Error("the result carried no text");
  }
  return block.text;
}

it("serves the workspace's tasks: a CLI change kept for later observers, tags, delivery, reads that change nothing, and kept after exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "mt-"));
  const home = testHome({ providers: false });
  const { state } = home.layout;
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
  const client = new Client({ name: "tasks-stdio", version: "1.0.0" });
  const cli = (...argv: readonly string[]) =>
    spawnSync("bun", cliArgs("tasks", ...argv, "--source", source), {
      cwd: root,
      encoding: "utf8",
      env: home.env,
      timeout: 15_000,
    });
  // A CLI change, made where no source runs and nothing observes, is kept
  // undelivered for the observers a later host declares. No Marbles process
  // runs yet, so the CLI opens the tasks itself and starts none.
  const fromCli = cli("create", "From CLI", "--tag", "cli", "--json");
  expect(fromCli.status, fromCli.stderr).toBe(0);
  // In the Marbles database; the workspace has no state dir of its own yet.
  expect(
    (await readdir(state)).filter(
      (name) => !(name.startsWith("marbles.db") || name === "locks")
    )
  ).toEqual([]);
  const kept = await stored(state);
  expect(kept.changes).toEqual([
    expect.objectContaining({
      delivered: 0,
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
    // The CLI hosts the workspace in the Marbles process; the server only
    // joins the worker that now owns the tasks.
    const attached = spawnSync("bun", cliArgs("attach", "--source", source), {
      cwd: root,
      encoding: "utf8",
      env: home.env,
      timeout: 60_000,
    });
    expect(attached.status, attached.stderr).toBe(0);
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

    // The worker delivers the CLI's change and the server's, oldest first:
    // one observer completes each, the other keeps failing.
    await vi.waitFor(
      async () => {
        expect(existsSync(seen)).toBe(true);
        const now = await stored(state);
        expect(now.changes.map((entry) => entry.delivered)).toEqual([1, 1]);
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

    const before = await stored(state);
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
    expect(before.tasks).toHaveLength(2);
    expect(await stored(state)).toEqual(before);

    // The worker hosting the workspace answers for its tasks: a separate
    // CLI process asks it, reads the same store, and changes nothing; a
    // refusal keeps its code across the process boundary.
    const routed = cli("list", "--tag", "review", "--json");
    expect(routed.status, routed.stderr).toBe(0);
    expect(JSON.parse(routed.stdout)).toMatchObject({
      items: [{ tags: ["review", "api"], title: "From MCP" }],
      total: 1,
    });
    expect(cli("get", "nope")).toMatchObject({
      status: 1,
      stderr: NOT_FOUND,
      stdout: "",
    });
    expect(await stored(state)).toEqual(before);
  } catch (error) {
    throw new Error(`MCP tasks session failed:\n${diagnostics}`, {
      cause: error,
    });
  } finally {
    await client.close();
  }
  try {
    // The Marbles process keeps hosting the workspace after the server
    // closes; once it stops, the next process reads what it wrote, and
    // reading changes none of the database's files.
    await stopDaemon(home);
    const after = cli("list", "--tag", "review", "--json");
    expect(after.status, after.stderr).toBe(0);
    expect(JSON.parse(after.stdout)).toMatchObject({
      items: [{ tags: ["review", "api"], title: "From MCP" }],
      total: 1,
    });
    const { changes } = await stored(state);
    expect(changes.map((entry) => entry.delivered)).toEqual([1, 1]);
    const settled = await files(state);
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
    expect(await files(state)).toEqual(settled);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 120_000);
