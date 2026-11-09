import { execFile } from "node:child_process";
import { realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, it, vi } from "vitest";
import { z } from "zod";
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

/**
 * The workflow as an MCP client sees it: a real STDIO server over a
 * throwaway repository. `--dry-run` echoes agent turns, so each structured
 * reply is the smallest value its schema accepts: no findings, nothing to
 * challenge. That proves the wiring and the packet, not review quality.
 */
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

  const transport = new StdioClientTransport({
    args: [resolve("src/mcp/stdio.ts"), "--source", source, "--dry-run"],
    command: "bun",
    cwd: root,
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
        last = run.parse(
          payload(
            await client.callTool({ arguments: { runId }, name: "get_run" })
          )
        );
        expect(["completed", "failed", "cancelled"]).toContain(last.status);
      },
      { interval: 100, timeout: 30_000 }
    );
    return last;
  };
  const dispatch = async (input: unknown) =>
    z.object({ runId: z.string() }).parse(
      payload(
        await client.callTool({
          arguments: { input, name: "adversarial-review" },
          name: "dispatch_workflow",
        })
      )
    ).runId;

  try {
    await client.connect(transport);
    const config = await client.callTool({
      arguments: {},
      name: "list_config",
    });
    expect(JSON.stringify(payload(config))).toContain('"adversarial-review"');

    // Close the client only once runs settle: a dry server cancels work
    // still running when its connection ends.
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
