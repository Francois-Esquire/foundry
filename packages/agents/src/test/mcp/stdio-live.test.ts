import { fileURLToPath } from "node:url";
import type { Tool, ToolExecutionOptions } from "ai";

import { afterEach, describe, expect, it, vi } from "vitest";
import { metaOf } from "../../harness/types";
import type { McpClientOptions, McpLogMessage } from "../../mcp";
import { McpClient, sdkStdioTransport, spawnStdioTransport } from "../../mcp";

// Drives the real @ai-sdk/mcp client over a real stdio subprocess: the only
// MCP tests in the package that do not mock the SDK.
const FIXTURE = fileURLToPath(
  new URL("./fixtures/echo-server.ts", import.meta.url)
);

const server = {
  id: "echo",
  transport: {
    args: [FIXTURE],
    command: process.execPath,
    kind: "stdio" as const,
  },
};

const callOptions: ToolExecutionOptions<unknown> = {
  context: undefined,
  messages: [],
  toolCallId: "call-1",
};

type Executable = Tool & { execute: NonNullable<Tool["execute"]> };

function toolOf(tools: Record<string, Tool>, name: string): Executable {
  const tool = tools[name];
  if (!tool?.execute) {
    throw new Error(`expected ${name} with execute`);
  }
  return { ...tool, execute: tool.execute };
}

async function textOf(tool: Executable, input: unknown): Promise<string> {
  const result = (await tool.execute(input, callOptions)) as {
    content: { type: string; text?: string }[];
  };
  return result.content[0]?.text ?? "";
}

const clients: McpClient[] = [];
async function connect(opts: McpClientOptions = {}): Promise<McpClient> {
  const client = new McpClient(server, opts);
  clients.push(client);
  await client.connect();
  return client;
}

afterEach(async () => {
  for (const c of clients.splice(0)) {
    await c.close();
  }
});

describe("stdio MCP server (live subprocess)", () => {
  it("connects, lists, calls a tool, and closes the subprocess", async () => {
    const client = await connect();
    expect(client.state()).toMatchObject({
      id: "echo",
      status: "connected",
      toolCount: 6,
    });
    const tool = toolOf(client.tools(), "echo__echo");
    expect(tool.description).toBe("Returns the text it is given");
    expect(metaOf(tool).source).toBe("mcp");
    expect(await textOf(tool, { text: "ping" })).toBe("ping");
    await client.close();
    expect(client.status).toBe("off");
    expect(client.tools()).toEqual({});
  });

  it("reports a server whose command dies as failed without throwing", async () => {
    const client = new McpClient({
      id: "dead",
      transport: {
        args: ["-e", "process.exit(1)"],
        command: process.execPath,
        kind: "stdio",
      },
    });
    clients.push(client);
    await client.connect();
    expect(client.state()).toMatchObject({
      id: "dead",
      status: "failed",
      toolCount: 0,
    });
    expect(client.tools()).toEqual({});
  });

  it("surfaces the server's instructions", async () => {
    const client = await connect();
    expect(client.instructions).toBe("Echo back what you are given.");
  });

  it("re-reads the tool list when the server announces a change", async () => {
    const client = await connect();
    const changed = new Promise<string>((resolve) => {
      client.on("tools", (c) => {
        resolve(c.id);
      });
    });
    await textOf(toolOf(client.tools(), "echo__grow"), {});
    expect(await changed).toBe("echo");
    expect(Object.keys(client.tools())).toContain("echo__shout");
    expect(client.state().toolCount).toBe(7);
  });

  it("refreshes a tool list on demand", async () => {
    const client = await connect();
    await textOf(toolOf(client.tools(), "echo__grow"), {});
    await client.refresh();
    expect(Object.keys(client.tools())).toContain("echo__shout");
  });

  it("answers elicitation requests through the handler set on the client", async () => {
    const client = await connect();
    const elicit = vi.fn().mockResolvedValue({
      action: "accept",
      content: { name: "Mike" },
    });
    client.elicit = elicit;
    const answer = await textOf(toolOf(client.tools(), "echo__ask"), {});
    expect(JSON.parse(answer)).toEqual({
      action: "accept",
      content: { name: "Mike" },
    });
    expect(elicit.mock.calls[0]?.[0]).toMatchObject({
      message: "What is your name?",
      requestedSchema: { type: "object" },
      serverId: "echo",
    });
  });

  it("declines on the user's behalf while no handler is set", async () => {
    const client = await connect();
    const answer = await textOf(toolOf(client.tools(), "echo__ask"), {});
    expect(JSON.parse(answer)).toEqual({ action: "decline" });
  });

  it("delivers log notifications", async () => {
    const client = await connect();
    const logs: McpLogMessage[] = [];
    client.on("log", (m) => logs.push(m));
    await textOf(toolOf(client.tools(), "echo__log"), {});
    expect(logs).toEqual([
      {
        data: "careful",
        level: "warning",
        logger: "fixture",
        serverId: "echo",
      },
    ]);
  });

  it("hands the server's stderr to the host one line at a time", async () => {
    const client = await connect();
    const logs: McpLogMessage[] = [];
    client.on("log", (m) => logs.push(m));
    await textOf(toolOf(client.tools(), "echo__stderr"), {});
    await vi.waitFor(() => {
      expect(logs).toHaveLength(2);
    });
    expect(logs).toEqual([
      {
        data: "first line",
        level: "error",
        logger: "stderr",
        serverId: "echo",
      },
      {
        data: "second line",
        level: "error",
        logger: "stderr",
        serverId: "echo",
      },
    ]);
  });

  it("marks a server that exits on its own as failed with the exit code", async () => {
    const client = await connect();
    const failures: string[] = [];
    client.on("status", (c) => {
      if (c.status === "failed") {
        failures.push(c.error ?? "");
      }
    });
    await textOf(toolOf(client.tools(), "echo__die"), {});
    await vi.waitFor(() => {
      expect(client.status).toBe("failed");
    });
    expect(client.error).toBe('MCP server "echo" exited (code 3)');
    expect(failures).toHaveLength(1);
    expect(client.tools()).toEqual({});
  });

  it("starts stdio servers through the injected spawn seam", async () => {
    const seen: string[] = [];
    const client = await connect({
      spawnStdio: (config, hooks) => {
        seen.push(config.command);
        return spawnStdioTransport(config, hooks);
      },
    });
    expect(seen).toEqual([process.execPath]);
    expect(client.status).toBe("connected");
  });

  it("still works over the SDK's own stdio transport, minus stderr", async () => {
    const client = await connect({ spawnStdio: sdkStdioTransport });
    const logs: McpLogMessage[] = [];
    client.on("log", (m) => logs.push(m));
    expect(
      await textOf(toolOf(client.tools(), "echo__echo"), { text: "hi" })
    ).toBe("hi");
    await textOf(toolOf(client.tools(), "echo__stderr"), {});
    await textOf(toolOf(client.tools(), "echo__log"), {});
    expect(logs.map((l) => l.logger)).toEqual(["fixture"]);
  });

  it("keeps a UTF-8 character that straddles two stdout chunks", async () => {
    const client = await connect();
    const text = "é".repeat(20_000);
    expect(await textOf(toolOf(client.tools(), "echo__echo"), { text })).toBe(
      text
    );
  });

  it("lists and reads resources, lists and expands prompts", async () => {
    const client = await connect();
    expect(await client.listResources()).toEqual([
      { mimeType: "text/plain", name: "hello", uri: "memo://hello" },
    ]);
    expect(await client.readResource("memo://hello")).toEqual([
      { mimeType: "text/plain", text: "hi there", uri: "memo://hello" },
    ]);
    expect(await client.listPrompts()).toEqual([
      {
        arguments: [{ name: "name", required: true }],
        description: "Greets someone",
        name: "greet",
      },
    ]);
    expect(await client.getPrompt("greet", { name: "Ada" })).toEqual([
      { content: { text: "Hello, Ada!", type: "text" }, role: "user" },
    ]);
  });

  it("rejects resource calls while not connected", async () => {
    const client = new McpClient(server);
    await expect(client.listResources()).rejects.toThrow(/not connected/u);
  });
});
