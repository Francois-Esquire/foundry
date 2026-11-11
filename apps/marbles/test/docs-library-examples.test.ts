import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Engine } from "@foundry.sh/marbles/lib";
import { afterEach, expect, it, vi } from "vitest";

import { catalog } from "~/authoring/catalog";
import { countOverMcp } from "../../documentation/marbles/library/_example/mcp-client";
import { countFiles } from "../../documentation/marbles/library/_example/standalone";
import { cliArgs } from "./helpers/cli";
import { stopDaemon } from "./helpers/daemon";

// The library docs show one `count` step run three ways. These run the
// documented files themselves, against the real engine, CLI, and MCP server.
const EXAMPLES = resolve(
  import.meta.dirname,
  "../../documentation/marbles/library/_example"
);
const MODULE = join(EXAMPLES, "count.ts");

const roots: string[] = [];

afterEach(async () => {
  catalog.reset();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function tempRoot(): Promise<string> {
  // Short on purpose: the state root holds the Marbles process's socket.
  const root = await mkdtemp(join(tmpdir(), "mx-"));
  roots.push(root);
  return root;
}

/** The documented module's own folder is its workspace root. */
async function exampleTsFiles(): Promise<number> {
  return (await readdir(EXAMPLES)).filter((name) => name.endsWith(".ts"))
    .length;
}

it("runs the count step in an embedded engine", async () => {
  const root = await tempRoot();
  await writeFile(join(root, "a.ts"), "");
  await writeFile(join(root, "b.ts"), "");
  await writeFile(join(root, "notes.md"), "");

  expect(await countFiles(root, ".ts")).toEqual({
    extension: ".ts",
    files: 2,
  });
});

it("disposes the example engine even if its stop fails", async () => {
  const error = new Error("stop failed");
  const start = vi
    .spyOn(Engine.prototype, "start")
    .mockImplementation(function (this: Engine) {
      return Promise.resolve(this);
    });
  const run = vi.spyOn(Engine.prototype, "run").mockResolvedValue({});
  const stop = vi.spyOn(Engine.prototype, "stop").mockRejectedValue(error);
  const dispose = vi.spyOn(Engine.prototype, "dispose").mockResolvedValue();
  try {
    await expect(countFiles(await tempRoot(), ".ts")).rejects.toBe(error);
    expect(dispose).toHaveBeenCalledOnce();
  } finally {
    start.mockRestore();
    run.mockRestore();
    stop.mockRestore();
    dispose.mockRestore();
  }
});

it("rolls the same module from the CLI and dispatches it over MCP", async () => {
  const state = join(await tempRoot(), "s");
  const expected = { extension: ".ts", files: await exampleTsFiles() };
  try {
    const rolled = spawnSync(
      "bun",
      cliArgs(
        "roll",
        "count",
        "--input",
        JSON.stringify({ extension: ".ts" }),
        "--source",
        MODULE,
        "--state",
        state
      ),
      { encoding: "utf8", timeout: 60_000 }
    );
    expect(rolled.status, rolled.stderr).toBe(0);
    expect(rolled.stdout).toContain(JSON.stringify(expected, null, 2));

    const run = await countOverMcp({
      server: resolve(import.meta.dirname, "../src/mcp/stdio.ts"),
      source: MODULE,
      state,
    });
    expect(run).toMatchObject({ output: expected, status: "completed" });
  } finally {
    await stopDaemon(state);
  }
}, 120_000);
