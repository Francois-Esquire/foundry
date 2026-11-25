import { execFile } from "node:child_process";
import { realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { RecordedStdioTransport } from "./helpers/mcp-stdio";
import { seedRepository } from "./helpers/repository";

const execFileAsync = promisify(execFile);

function payload(value: unknown): unknown {
  const [block] = CallToolResultSchema.parse(value).content;
  if (block?.type !== "text") {
    throw new Error("the tool returned no text");
  }
  return JSON.parse(block.text);
}

const run = z.object({
  error: z.unknown().optional(),
  output: z.unknown().optional(),
  status: z.string(),
});

it("dispatches adversarial-review over STDIO MCP and reads both axes back", async () => {
  const root = await realpath(await seedRepository());
  const git = (...args: string[]) =>
    execFileAsync("git", ["-C", root, ...args]);
  await git("checkout", "-b", "feature");
  await writeFile(join(root, "AGENTS.md"), "Keep functions small.\n");
  await writeFile(join(root, "change.ts"), "export const x = 1;\n");
  const source = join(root, "marbles.ts");
  await writeFile(
    source,
    `import ${JSON.stringify(resolve("examples/adversarial-review.ts"))};\n`
  );
  await git("add", "AGENTS.md", "change.ts", "marbles.ts");
  await git("commit", "-m", "change");

  const transport = new RecordedStdioTransport({
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
  const client = new Client({ name: "adversarial-review", version: "1.0.0" });
  const settled = async (runId: string) => {
    let last: z.output<typeof run> | undefined;
    await vi.waitFor(
      async () => {
        last = z.object({ item: run }).parse(
          payload(
            await client.callTool({
              arguments: { id: runId, resource: "run" },
              name: "get",
            })
          )
        ).item;
        expect(["completed", "failed", "cancelled"]).toContain(last.status);
      },
      { interval: 100, timeout: 30_000 }
    );
    return last;
  };
  const dispatch = async (input: unknown) =>
    z.object({ id: z.string() }).parse(
      payload(
        await client.callTool({
          arguments: { input, name: "adversarial-review" },
          name: "enqueue_workflow",
        })
      )
    ).id;

  try {
    await client.connect(transport);
    const config = await client.callTool({
      arguments: {
        filter: { name: "adversarial-review" },
        resource: "definitions",
      },
      name: "list",
    });
    expect(JSON.stringify(payload(config))).toContain('"adversarial-review"');

    const done = await settled(
      await dispatch({ spec: "Export x.", worktree: "." })
    );
    expect(done?.status, diagnostics).toBe("completed");
    expect(done?.output).toMatchObject({
      files: [
        expect.objectContaining({ path: "AGENTS.md" }),
        expect.objectContaining({ path: "change.ts" }),
        expect.objectContaining({ path: "marbles.ts" }),
      ],
      instructions: ["AGENTS.md"],
      spec: {
        findings: [],
        review: { status: "completed" },
        status: "completed",
      },
      standards: {
        challenge: { status: "skipped" },
        findings: [],
        review: { status: "completed" },
        status: "completed",
      },
      status: "complete",
    });

    const failed = await settled(await dispatch({ base: "missing" }));
    expect(failed?.status).toBe("failed");
    expect(JSON.stringify(failed?.error)).toContain(
      '\\"missing\\" does not name a commit'
    );
  } finally {
    await client.close();
    await rm(root, { force: true, recursive: true });
  }
}, 60_000);
