/**
 * What a person sees when the Marbles database refuses a task command: one
 * line from the CLI, an MCP tool error carrying the message, and never a
 * stack trace, whether the command reached stored state or the generation that
 * hosts the workspace.
 */

import { spawn, spawnSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ReentrantCallError } from "@foundry/lib/turns";
import { Tasks } from "@foundry/tasks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "~/database/migrate";
import { initializeDatabase } from "~/database/open";
import { TaskStorageError } from "~/database/tasks";
import { stateDatabase } from "~/layout";
import { cliArgs } from "./helpers/cli";
import { type TestHome, testHome } from "./helpers/home";
import { RecordedStdioTransport } from "./helpers/mcp-stdio";
import { testMachine } from "./helpers/records";

const SRC = resolve("src");
const ONE_LINE = /^marbles: [^\n]+\n$/;
const UNSTORABLE =
  /^marbles: this change cannot be stored in the Marbles database: SqliteTaskStore cannot store putTasks\[0\]\.title: [^\n]+\n$/;
const NEWER = /migrated by a newer Marbles/;
const BUSY = /the Marbles database is busy/;

const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
});

/** A batch creating one task titled `title`, as `tasks change --input` takes it. */
function creating(title: string) {
  return {
    operations: [{ input: { title }, key: "t", kind: "task.create" }],
  };
}

function marbles(home: TestHome, ...argv: readonly string[]) {
  return spawnSync("bun", cliArgs(...argv), {
    cwd: home.path,
    encoding: "utf8",
    env: home.env,
    timeout: 30_000,
  });
}

/** A database migrated by a Marbles one migration ahead of this one. */
async function newerDatabase(state: string): Promise<void> {
  const folder = join(state, "..", "migrations-next");
  cpSync(MIGRATIONS, folder, { recursive: true });
  const path = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(path, "utf8")) as {
    entries: { tag: string; when: number }[];
  };
  const last = journal.entries.at(-1);
  if (last === undefined) {
    throw new Error("no migrations are committed");
  }
  journal.entries.push({ ...last, tag: "9999_probe", when: last.when + 1 });
  writeFileSync(path, JSON.stringify(journal));
  writeFileSync(
    join(folder, "9999_probe.sql"),
    "CREATE TABLE `probe` (`id` text PRIMARY KEY NOT NULL);\n"
  );
  (
    await initializeDatabase(stateDatabase(state), { migrations: folder })
  ).close();
}

/**
 * Another process holding the database's write lock, longer than the busy
 * timeout; resolves once it has it.
 */
async function holdWriteLock(home: TestHome): Promise<void> {
  const { state } = home.layout;
  (await initializeDatabase(stateDatabase(state))).close();
  const script = join(state, "..", "hold.ts");
  writeFileSync(
    script,
    `import { openDatabase } from ${JSON.stringify(join(SRC, "database/open.ts"))};
const opened = await openDatabase(${JSON.stringify(stateDatabase(state))});
const held = await opened.database.$client.transaction("write");
await held.execute("INSERT INTO marbles_workspaces (first_seen, id, last_seen, root) VALUES ('t', 'holder', 't', '/')");
process.stdout.write("held\\n");
await new Promise((done) => setTimeout(done, 30_000));
// Used after the wait, so the transaction is not collected, and rolled back, before.
await held.rollback();
`
  );
  // Recorded in the home, so its teardown stops it.
  const holder = spawn("bun", [script], { cwd: resolve("."), env: home.env });
  home.track(holder.pid, false);
  await new Promise<void>((ready, failed) => {
    holder.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("held")) {
        ready();
      }
    });
    holder.once("exit", (code) => failed(new Error(`holder exited ${code}`)));
  });
}

/** The text of a tool result that must be an error, checked to be one plain line. */
function toolError(value: unknown): string {
  const result = CallToolResultSchema.parse(value);
  expect(result.isError).toBe(true);
  const [block] = result.content;
  if (block?.type !== "text") {
    throw new Error("the result carried no text");
  }
  expect(block.text).not.toContain("\n    at ");
  return block.text;
}

/** An MCP server in `home`, for the workspace at its root. */
async function mcp(home: TestHome): Promise<Client> {
  const transport = new RecordedStdioTransport({
    args: ["--no-env-file", resolve("src/cli.ts"), "mcp"],
    command: "bun",
    cwd: home.path,
    env: home.env,
    stderr: "pipe",
  });
  const client = new Client({ name: "tasks-errors", version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

function change(client: Client, title: string) {
  return client.callTool({ arguments: creating(title), name: "change_tasks" });
}

describe("a task command the database refuses", { timeout: 60_000 }, () => {
  it("names the field holding text it cannot store, in one line", async () => {
    const home = testHome();
    for (const title of ["a\u0000b", "lone \ud800"]) {
      const refused = marbles(
        home,
        "tasks",
        "change",
        "--input",
        JSON.stringify(creating(title))
      );
      expect(refused.status).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toMatch(UNSTORABLE);
    }
    const client = await mcp(home);
    expect(toolError(await change(client, "a\u0000b"))).toMatch(
      "cannot be stored in the Marbles database"
    );
    expect(marbles(home, "tasks", "list", "--json").stdout).toContain(
      '"total": 0'
    );
  });

  it("names text it cannot store when the generation that hosts the workspace refuses it", async () => {
    const home = testHome();
    const source = join(home.path, "marbles.ts");
    writeFileSync(source, 'import "@foundry.sh/marbles";\n');
    // The CLI starts the Marbles process, which hosts the workspace; the
    // home's teardown stops it.
    const attached = marbles(home, "attach", "--source", source);
    expect(attached.status, attached.stderr).toBe(0);
    const refused = marbles(
      home,
      "tasks",
      "change",
      "--input",
      JSON.stringify(creating("a\u0000b")),
      "--source",
      source
    );
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(ONE_LINE);
    expect(refused.stderr).toContain(
      "cannot be stored in the Marbles database"
    );
  });

  it("says a newer Marbles migrated the database, in one line", async () => {
    const home = testHome();
    await newerDatabase(home.layout.state);
    for (const argv of [
      ["tasks", "list"],
      ["tasks", "create", "Refused"],
    ]) {
      const refused = marbles(home, ...argv);
      expect(refused.status, argv.join(" ")).toBe(1);
      expect(refused.stderr).toMatch(ONE_LINE);
      expect(refused.stderr).toMatch(NEWER);
    }
    const client = await mcp(home);
    expect(
      toolError(await client.callTool({ arguments: {}, name: "list_tasks" }))
    ).toMatch(NEWER);
    expect(toolError(await change(client, "Refused"))).toMatch(NEWER);
  });

  it("says the database stayed busy, in one line", async () => {
    const home = testHome();
    await holdWriteLock(home);
    const refused = marbles(home, "tasks", "create", "Waiting");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(ONE_LINE);
    expect(refused.stderr).toMatch(BUSY);
    const client = await mcp(home);
    expect(toolError(await change(client, "Waiting"))).toMatch(BUSY);
  });
});

describe("the database's task store", () => {
  it("refuses a call to itself from inside its own transaction at once, never waiting on itself", async () => {
    const machine = await testMachine();
    try {
      const records = machine.records(machine.workspace());
      const { taskStore } = records;
      const { transaction } = taskStore;
      if (transaction === undefined) {
        throw new Error("the store offers no transaction");
      }
      const started = Date.now();
      await expect(
        transaction(() => new Tasks({ store: taskStore }).list())
      ).rejects.toThrow(ReentrantCallError);
      expect(Date.now() - started).toBeLessThan(1000);
      await records.close();
    } finally {
      machine.close();
    }
  });

  it("refuses text it cannot store as a TaskStorageError, before writing anything", async () => {
    const machine = await testMachine();
    try {
      const state = machine.workspace();
      const records = machine.records(state);
      const tasks = new Tasks({ store: records.taskStore });
      await expect(tasks.create({ title: "a\u0000b" })).rejects.toThrow(
        TaskStorageError
      );
      expect((await tasks.list()).items).toEqual([]);
      expect(await machine.changes(state)).toEqual([]);
      await records.close();
    } finally {
      machine.close();
    }
  });
});
