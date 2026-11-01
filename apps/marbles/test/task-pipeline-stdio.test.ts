import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { ROUTER_MODEL_ENV } from "../examples/task-pipeline/pipeline";

const pipelineTask = z.object({
  metadata: z.object({
    pipeline: z
      .object({
        outcome: z.object({ reason: z.string().optional() }).loose().optional(),
        route: z
          .object({ source: z.string(), workflow: z.string() })
          .loose()
          .optional(),
        stage: z.string(),
      })
      .loose()
      .optional(),
  }),
  status: z.string(),
});

function payload(value: unknown): unknown {
  const [block] = CallToolResultSchema.parse(value).content;
  if (block?.type !== "text") {
    throw new Error("the tool returned no text");
  }
  return JSON.parse(block.text);
}

/**
 * The pipeline as an MCP client drives it: a real STDIO server over a
 * workspace that declares it with one destination double. `--dry-run`
 * answers each structured turn with the smallest value its schema accepts,
 * so refinement is never ready by itself and the router is never asked:
 * the run proves the wiring, not model quality.
 */
it("creates a task over MCP, refines it, routes it only through explicit requests, and completes it only when accepted", async () => {
  const root = await mkdtemp(join(tmpdir(), "mtp-"));
  const source = join(root, "marbles.ts");
  const zod = createRequire(import.meta.url).resolve("zod");
  await writeFile(
    source,
    `import { step } from "@foundry.sh/marbles";
import { z } from ${JSON.stringify(zod)};
import { taskPipeline } from ${JSON.stringify(resolve("examples/task-pipeline/pipeline.ts"))};
import { destination } from ${JSON.stringify(resolve("examples/task-pipeline/route.ts"))};
const work = step("work-double")
  .input(z.object({ spec: z.string() }))
  .do(({ input }) => ({ worked: input.spec.split("\\n")[0] }));
taskPipeline({
  destinations: [destination({ build: (brief) => ({ spec: brief.spec }), choose: z.object({}), definition: work, description: "Do the work." })],
});
`
  );
  const { [ROUTER_MODEL_ENV]: _unset, ...env } = process.env;
  const transport = new StdioClientTransport({
    args: [resolve("src/mcp/stdio.ts"), "--source", source, "--dry-run"],
    command: "bun",
    cwd: root,
    env: env as Record<string, string>,
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const client = new Client({ name: "task-pipeline", version: "1.0.0" });
  const read = async (id: string) =>
    z
      .object({ task: pipelineTask })
      .parse(
        (await client.callTool({ arguments: { id }, name: "get_task" }))
          .structuredContent
      ).task;
  const reaches = async (id: string, stage: string) => {
    await vi.waitFor(
      async () =>
        expect((await read(id)).metadata.pipeline?.stage, diagnostics).toBe(
          stage
        ),
      { interval: 100, timeout: 30_000 }
    );
    return read(id);
  };
  const requestRun = async (input: Record<string, unknown>) => {
    const { runId } = z.object({ runId: z.string() }).parse(
      payload(
        await client.callTool({
          arguments: { input, name: "task-pipeline-request" },
          name: "dispatch_workflow",
        })
      )
    );
    await vi.waitFor(
      async () => {
        const status = z
          .object({ status: z.string() })
          .loose()
          .parse(
            payload(
              await client.callTool({ arguments: { runId }, name: "get_run" })
            )
          );
        expect(status.status).toBe("completed");
      },
      { interval: 100, timeout: 30_000 }
    );
  };

  try {
    await client.connect(transport);
    const config = JSON.stringify(
      payload(await client.callTool({ arguments: {}, name: "list_config" }))
    );
    for (const name of [
      "task-pipeline-request",
      "task-pipeline-reconcile",
      "work-double",
    ]) {
      expect(config).toContain(`"${name}"`);
    }

    const created = await client.callTool({
      arguments: {
        operations: [
          {
            input: { tags: ["pipeline"], title: "From MCP" },
            key: "task",
            kind: "task.create",
          },
          {
            input: { title: "Not in the pipeline" },
            key: "other",
            kind: "task.create",
          },
        ],
      },
      name: "change_tasks",
    });
    const { tasks } = z
      .object({ tasks: z.array(z.object({ id: z.string() })) })
      .parse(created.structuredContent);
    const [task, other] = tasks;
    if (task === undefined || other === undefined) {
      throw new Error("change_tasks created no tasks");
    }

    // The dry refiner's smallest reply is not ready: it asks, and nothing runs.
    await reaches(task.id, "needs-clarification");
    expect((await read(other.id)).metadata.pipeline).toBeUndefined();

    // Accepted as is: routing has no model configured, so it is blocked.
    await requestRun({ action: "prepare", taskId: task.id });
    const blocked = await reaches(task.id, "blocked");
    expect(blocked.metadata.pipeline?.outcome?.reason).toContain(
      ROUTER_MODEL_ENV
    );

    // A route the user names is checked, then run with the task as context.
    await requestRun({
      action: "reroute",
      taskId: task.id,
      workflow: "work-double",
    });
    const done = await reaches(task.id, "awaiting-acceptance");
    expect(done.status).toBe("active");
    expect(done.metadata.pipeline?.route).toMatchObject({
      source: "user",
      workflow: "work-double",
    });

    // Only an explicit acceptance completes it.
    await requestRun({ action: "accept", taskId: task.id });
    const accepted = await reaches(task.id, "accepted");
    expect(accepted.status).toBe("completed");

    // The start guard is the task command language's, so MCP has it too.
    const blocker = await client.callTool({
      arguments: {
        operations: [
          { input: { title: "Blocker" }, key: "blocker", kind: "task.create" },
          {
            dependsOn: { key: "blocker" },
            kind: "dependency.add",
            task: { id: other.id },
          },
        ],
      },
      name: "change_tasks",
    });
    expect(blocker.isError).not.toBe(true);
    const refused = await client.callTool({
      arguments: {
        operations: [
          {
            kind: "task.set_status",
            requireReady: true,
            status: "active",
            task: { id: other.id },
          },
        ],
      },
      name: "change_tasks",
    });
    expect(JSON.stringify(refused.content)).toContain("not_ready");
    expect((await read(other.id)).status).toBe("open");
  } finally {
    await client.close();
    await rm(root, { force: true, recursive: true });
  }
}, 90_000);
