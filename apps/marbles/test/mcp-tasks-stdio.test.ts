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
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { readDatabase } from "~/database/open";
import { marblesChanges, marblesObservers } from "~/database/tables";
import { stateDatabase } from "~/layout";
import { cliArgs } from "./helpers/cli";
import { stopDaemon } from "./helpers/daemon";
import { testHome } from "./helpers/home";
import { RecordedStdioTransport } from "./helpers/mcp-stdio";

const change = z.object({
  payload: z.object({
    tasks: z.array(
      z.object({ after: z.object({ tags: z.array(z.string()) }).loose() })
    ),
    type: z.literal("tasks.changed"),
  }),
  position: z.number(),
});
const records = z.object({
  changes: z.array(change),
  tasks: z.array(z.object({ tags: z.array(z.string()), title: z.string() })),
});

async function stored(state: string): Promise<z.infer<typeof records>> {
  const read = await readDatabase(stateDatabase(state), async (database) => {
    const changes = await database
      .select({
        payload: marblesChanges.payload,
        position: marblesChanges.position,
      })
      .from(marblesChanges)
      .where(eq(marblesChanges.source, "tasks"))
      .orderBy(marblesChanges.position);
    const tasks = await database
      .select({ tags: taskRows.tags, title: taskRows.title })
      .from(taskRows)
      .orderBy(taskRows.position);
    return { changes, tasks };
  });
  return records.parse(read);
}

async function observers(state: string) {
  const read = await readDatabase(stateDatabase(state), (database) =>
    database
      .select({
        failures: marblesObservers.failures,
        name: marblesObservers.name,
        position: marblesObservers.position,
      })
      .from(marblesObservers)
      .orderBy(marblesObservers.name)
  );
  return (read ?? []).map((row) => ({
    failing: row.failures > 0,
    name: row.name,
    position: row.position,
  }));
}

async function files(state: string) {
  const names = (await readdir(state)).filter((name) =>
    name.startsWith("marbles.db")
  );
  return await Promise.all(
    names.sort().map(async (name) => {
      const path = join(state, name);
      const { mtimeMs, size } = await stat(path);
      return name.endsWith("-shm")
        ? { name, size }
        : { bytes: await readFile(path, "base64"), mtimeMs, name, size };
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

it("serves the workspace's tasks: a CLI change logged before any observer, tags, delivery from the observer's start, reads that change nothing, and kept after exit", async () => {
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
}, { name: "seen" });
// Keeps failing, so it stays where it started.
observe(tasks, () => {
  throw new Error("not yet");
}, { name: "failing" });
step("titles").do(async () => (await tasks.list()).items.map((task) => task.title));`
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
  const client = new Client({ name: "tasks-stdio", version: "1.0.0" });
  const cli = (...argv: readonly string[]) =>
    spawnSync("bun", cliArgs("tasks", ...argv, "--source", source), {
      cwd: root,
      encoding: "utf8",
      env: home.env,
      timeout: 15_000,
    });
  const fromCli = cli("create", "From CLI", "--tag", "cli", "--json");
  expect(fromCli.status, fromCli.stderr).toBe(0);
  expect(
    (await readdir(state)).filter(
      (name) => !(name.startsWith("marbles.db") || name === "locks")
    )
  ).toEqual([]);
  const kept = await stored(state);
  expect(kept.changes).toEqual([
    expect.objectContaining({
      payload: expect.objectContaining({
        tasks: [
          expect.objectContaining({
            after: expect.objectContaining({ tags: ["cli"] }),
          }),
        ],
      }),
      position: 1,
    }),
  ]);
  try {
    const attached = spawnSync(
      "bun",
      cliArgs("daemon", "attach", "--source", source),
      {
        cwd: root,
        encoding: "utf8",
        env: home.env,
        timeout: 60_000,
      }
    );
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

    const run = z.object({ id: z.string() }).parse(
      JSON.parse(
        text(
          await client.callTool({
            arguments: { name: "titles" },
            name: "enqueue_workflow",
          })
        )
      )
    );
    await vi.waitFor(async () => {
      const status = text(
        await client.callTool({
          arguments: { id: run.id, resource: "run" },
          name: "get",
        })
      );
      expect(status).toContain('"status":"completed"');
      expect(status).toContain('["From CLI","From MCP"]');
    });

    await vi.waitFor(
      async () => {
        expect(existsSync(seen)).toBe(true);
        const { changes } = await stored(state);
        expect(await observers(state)).toEqual([
          { failing: true, name: "failing", position: 1 },
          {
            failing: false,
            name: "seen",
            position: expect.toSatisfy(
              (position: number) =>
                position >= (changes.at(-1)?.position ?? Number.NaN)
            ),
          },
        ]);
      },
      { timeout: 10_000 }
    );
    const payloads = (await readFile(seen, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(payloads).toMatchObject([
      {
        tasks: [{ after: { tags: ["review", "api"] }, before: null }],
        type: "tasks.changed",
      },
    ]);

    const before = await stored(state);
    const listed = await client.callTool({
      arguments: {
        filter: { tags: { all: ["review"], any: ["api", "x"] } },
        resource: "tasks",
      },
      name: "list",
    });
    expect(listed.isError, JSON.stringify(listed)).not.toBe(true);
    expect(listed.structuredContent).toMatchObject({
      items: [{ tags: ["review", "api"], title: "From MCP" }],
      total: 1,
    });
    const ready = await client.callTool({
      arguments: {
        filter: { ready: true, tags: { all: ["missing"] } },
        resource: "tasks",
      },
      name: "list",
    });
    expect(ready.structuredContent).toEqual({ items: [], total: 0 });
    expect(before.tasks).toHaveLength(2);
    expect(await stored(state)).toEqual(before);

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
    await stopDaemon(home);
    const after = cli("list", "--tag", "review", "--json");
    expect(after.status, after.stderr).toBe(0);
    expect(JSON.parse(after.stdout)).toMatchObject({
      items: [{ tags: ["review", "api"], title: "From MCP" }],
      total: 1,
    });
    const { changes } = await stored(state);
    expect(changes).toHaveLength(2);
    expect(changes[0]?.position).toBe(1);
    const [failing, seenBy] = await observers(state);
    expect(failing?.position).toBe(1);
    expect(seenBy?.position).toBeGreaterThanOrEqual(changes[1]?.position ?? 0);
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
