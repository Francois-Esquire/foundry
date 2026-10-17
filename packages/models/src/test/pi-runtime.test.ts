import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText, tool } from "ai";
import { expect, it } from "vitest";
import { z } from "zod";
import { createPiDriver } from "../harness/pi";
import { piProvider } from "../pi";
import { collect, runOptions } from "./helpers/cli";

/** Runs the actual CLI and a local fixture provider, with no vendor credentials or paid calls. */
it("runs Pi's real tool loop, persists native history, and serves the model API", async () => {
  const binPath = process.env.PI_BIN;
  if (!binPath) {
    throw new Error("Set PI_BIN to the Pi 1.3.0 executable to run test:pi.");
  }
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-test-"));
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      unknown
    >;
    requests.push(body);
    const messages = body.messages as {
      role: string;
      content?: string;
      tool_call_id?: string;
    }[];
    const last = messages.at(-1);
    let delta: unknown = { content: "Pi runtime verified" };
    let finish = "stop";
    if (JSON.stringify(last?.content).includes("Read and update the marker")) {
      delta = {
        tool_calls: [
          {
            function: { arguments: '{"path":"marker.txt"}', name: "read" },
            id: "read-1",
            index: 0,
            type: "function",
          },
        ],
      };
      finish = "tool_calls";
    } else if (last?.tool_call_id === "read-1") {
      delta = {
        tool_calls: [
          {
            function: {
              arguments: '{"path":"marker.txt","text":"updated by Pi"}',
              name: "write",
            },
            id: "write-1",
            index: 0,
            type: "function",
          },
        ],
      };
      finish = "tool_calls";
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const value of [
      { choices: [{ delta, finish_reason: null, index: 0 }] },
      {
        choices: [{ delta: {}, finish_reason: finish, index: 0 }],
        usage: { completion_tokens: 2, prompt_tokens: 4, total_tokens: 6 },
      },
    ]) {
      response.write(
        `data: ${JSON.stringify({ created: 1, id: "fixture", model: "fixture", object: "chat.completion.chunk", ...value })}\n\n`
      );
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing fixture server address.");
  }
  const environment = {
    FOUNDRY_PI_API_KEY: "fixture-key",
    HOME: root,
    PATH: process.env.PATH ?? "",
    PI_CODING_AGENT_DIR: root,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  const pathSchema = z.object({ path: z.literal("marker.txt") });
  let nativeSessionId: string | undefined;
  const outcomes: string[] = [];
  const options = {
    agentId: "fixture",
    binPath,
    cwd: root,
    env: environment,
    modelId: "fixture/fixture",
    spawn: async (
      argv: readonly string[],
      settings: {
        cwd: string;
        env: Readonly<Record<string, string>>;
        signal: AbortSignal;
      }
    ) =>
      spawn(argv[0] ?? binPath, argv.slice(1), {
        cwd: settings.cwd,
        env: settings.env,
        signal: settings.signal,
      }),
    async writeExtension(source: string) {
      const path = join(root, "tools.mjs");
      await writeFile(path, source);
      return path;
    },
  };
  const driver = createPiDriver(options);
  try {
    await writeFile(
      join(root, "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            models: [
              {
                contextWindow: 4096,
                cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
                id: "fixture",
                input: ["text"],
                maxTokens: 1024,
                name: "Fixture",
                reasoning: false,
              },
            ],
          },
        },
      })
    );
    await writeFile(join(root, "marker.txt"), "original");
    const tools = {
      read: tool({
        execute: ({ path }) => readFile(join(root, path), "utf8"),
        inputSchema: pathSchema,
      }),
      write: tool({
        execute: async ({ path, text }) => {
          await writeFile(join(root, path), text);
          return "written";
        },
        inputSchema: pathSchema.extend({ text: z.string() }),
      }),
    };
    const parts = await collect(
      await driver.run(
        runOptions({
          input: "Read and update the marker",
          onSessionId: async (id) => {
            nativeSessionId = id;
          },
          onToolEvent: async (event) => {
            outcomes.push(event.outcome);
          },
          permission: async () => ({ behavior: "allow" }),
          profile: {
            allowedTools: ["read", "write"],
            disallowedTools: [],
            maxSteps: 4,
            mode: "scheduled",
            unresolved: "deny",
          },
          tools,
        })
      )
    );
    expect(parts).toContainEqual(
      expect.objectContaining({
        text: "Pi runtime verified",
        type: "text-delta",
      })
    );
    expect(await readFile(join(root, "marker.txt"), "utf8")).toBe(
      "updated by Pi"
    );
    expect(outcomes).toEqual(["started", "ran", "started", "ran"]);
    const resumed = createPiDriver(options);
    try {
      await collect(
        await resumed.run(
          runOptions({
            input: "Confirm the previous result",
            nativeSessionId,
            tools,
          })
        )
      );
      expect(JSON.stringify(requests.at(-1))).toContain("updated by Pi");
    } finally {
      await resumed.close?.();
    }
    await writeFile(join(root, "marker.txt"), "original");
    const denied = createPiDriver({
      ...options,
      nativeTools: ["read"],
      persist: false,
    });
    const refused: string[] = [];
    try {
      await collect(
        await denied.run(
          runOptions({
            input: "Read and update the marker",
            onToolEvent: async (event) => {
              refused.push(event.outcome);
            },
            permission: async () => ({
              behavior: "deny",
              message: "Fixture refusal",
            }),
          })
        )
      );
      expect(refused).toEqual(["started", "refused"]);
      expect(JSON.stringify(requests)).toContain("Fixture refusal");
    } finally {
      await denied.close?.();
    }
    const model = piProvider({
      config: { available: true, binPath, env: environment },
    });
    const result = await generateText({
      model: model.languageModel("fixture/fixture", { workingDirectory: root }),
      prompt: "Read and update the marker",
    });
    expect(result.text).toBe("Pi runtime verified");
    expect(await readFile(join(root, "marker.txt"), "utf8")).toBe("original");
  } finally {
    await driver.close?.();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    await rm(root, { force: true, recursive: true });
  }
}, 60_000);
