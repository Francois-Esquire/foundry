import { tool } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { metaOf } from "../../harness/tool-registration";
import { McpClient } from "../../mcp/client";

const { createMCPClient } = vi.hoisted(() => ({ createMCPClient: vi.fn() }));
vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient,
  ElicitationRequestSchema: {},
}));
const spawnStdio = vi.fn((config: unknown) => ({ config }) as never);

function fakeClient(toolNames: string[]) {
  const close = vi.fn(() => Promise.resolve());
  const tools = Object.fromEntries(
    toolNames.map((name) => [
      name,
      tool({
        description: name,
        execute: () => Promise.resolve({ ok: name }),
        inputSchema: z.object({ q: z.string() }),
      }),
    ])
  );
  return {
    client: {
      close,
      onElicitationRequest: vi.fn(),
      tools: () => Promise.resolve(tools),
    },
    close,
  };
}

function remote(id: string, url: string, enabled = true) {
  return {
    enabled,
    id,
    transport: { kind: "remote" as const, protocol: "http" as const, url },
  };
}

beforeEach(() => {
  createMCPClient.mockReset();
  spawnStdio.mockClear();
});

describe("McpClient lifecycle", () => {
  it("stays off for a disabled definition", async () => {
    const client = new McpClient(remote("off", "http://off/mcp", false));

    await client.update(client.definition);

    expect(createMCPClient).not.toHaveBeenCalled();
    expect(client.state()).toMatchObject({ enabled: false, status: "off" });
  });

  it("enable connects and disable closes", async () => {
    const a = fakeClient(["a"]);
    createMCPClient.mockResolvedValueOnce(a.client);
    const client = new McpClient(remote("a", "http://a/mcp", false));

    await client.enable();
    expect(Object.keys(client.tools())).toEqual(["a__a"]);

    await client.disable();
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(client.status).toBe("off");
    expect(client.enabled).toBe(false);
    expect(client.tools()).toEqual({});
  });

  it("repeated connect() never reconnects", async () => {
    createMCPClient.mockResolvedValueOnce(fakeClient(["a"]).client);
    const client = new McpClient(remote("a", "http://a/mcp"));

    await client.connect();
    await client.connect();

    expect(createMCPClient).toHaveBeenCalledTimes(1);
  });

  it("reconnects when a redefinition changes connection detail", async () => {
    const v1 = fakeClient(["a"]);
    const v2 = fakeClient(["a"]);
    createMCPClient
      .mockResolvedValueOnce(v1.client)
      .mockResolvedValueOnce(v2.client);
    const client = new McpClient(remote("a", "http://a/mcp"));

    await client.connect();
    await client.update(remote("a", "http://a/v2/mcp"));

    expect(v1.close).toHaveBeenCalledTimes(1);
    expect(createMCPClient).toHaveBeenCalledTimes(2);
  });

  it("keeps the connection when only metadata changes", async () => {
    createMCPClient.mockResolvedValueOnce(fakeClient(["a"]).client);
    const client = new McpClient({
      ...remote("a", "http://a/mcp"),
      name: "A",
    });

    await client.connect();
    await client.update({ ...remote("a", "http://a/mcp"), name: "A renamed" });

    expect(createMCPClient).toHaveBeenCalledTimes(1);
    expect(client.definition.name).toBe("A renamed");
  });

  it("restarts a stdio client when its resolved environment changes", async () => {
    const v1 = fakeClient(["a"]);
    const v2 = fakeClient(["a"]);
    createMCPClient
      .mockResolvedValueOnce(v1.client)
      .mockResolvedValueOnce(v2.client);
    const local = (token: string) => ({
      enabled: true,
      id: "local",
      transport: {
        args: ["server.js"],
        command: "node",
        env: { TOKEN: token },
        kind: "stdio" as const,
      },
    });
    const client = new McpClient(local("one"), { spawnStdio });

    await client.connect();
    await client.update(local("two"));

    expect(v1.close).toHaveBeenCalledTimes(1);
    expect(spawnStdio).toHaveBeenLastCalledWith(
      local("two").transport,
      expect.objectContaining({})
    );
  });

  it("reports a failed connection through status events and state", async () => {
    createMCPClient.mockRejectedValueOnce(new Error("refused"));
    const client = new McpClient(remote("down", "http://down/mcp"));
    const statuses: string[] = [];
    client.on("status", (c) => statuses.push(c.status));

    await client.connect();

    expect(statuses).toEqual(["connecting", "failed"]);
    expect(client.state()).toMatchObject({
      error: "refused",
      status: "failed",
    });
  });

  it("retries a failed client only after the cooldown elapses", async () => {
    vi.useFakeTimers();
    try {
      createMCPClient
        .mockRejectedValueOnce(new Error("refused"))
        .mockResolvedValueOnce(fakeClient(["a"]).client);
      const client = new McpClient(remote("a", "http://a/mcp"), {
        retryCooldownMs: 1000,
      });

      await client.connect();
      expect(client.status).toBe("failed");
      expect(createMCPClient).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(500);
      await client.connect();
      expect(createMCPClient).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(600);
      await client.connect();
      expect(createMCPClient).toHaveBeenCalledTimes(2);
      expect(Object.keys(client.tools())).toEqual(["a__a"]);
      expect(client.status).toBe("connected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("redefining a failed client unchanged leaves it to its cooldown", async () => {
    createMCPClient.mockRejectedValue(new Error("refused"));
    const client = new McpClient(remote("a", "http://a/mcp"), {
      retryCooldownMs: 60_000,
    });
    await client.connect();

    await client.update(remote("a", "http://a/mcp"));

    expect(createMCPClient).toHaveBeenCalledTimes(1);
  });

  it("re-enabling a failed client retries immediately", async () => {
    createMCPClient
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValueOnce(fakeClient(["a"]).client);
    const client = new McpClient(remote("a", "http://a/mcp"), {
      retryCooldownMs: 60_000,
    });
    await client.connect();

    await client.disable();
    await client.enable();

    expect(createMCPClient).toHaveBeenCalledTimes(2);
    expect(client.status).toBe("connected");
  });

  it("redacts resolved environment values from errors and summaries", async () => {
    createMCPClient.mockRejectedValueOnce(new Error("bad secret-token"));
    const client = new McpClient(
      {
        enabled: true,
        id: "local",
        transport: {
          command: "node",
          env: { TOKEN: "secret-token" },
          kind: "stdio",
        },
      },
      { spawnStdio }
    );
    await client.connect();

    expect(client.state()).toEqual({
      enabled: true,
      error: "bad [redacted]",
      id: "local",
      server: {
        id: "local",
        transport: {
          args: [],
          command: "node",
          envNames: ["TOKEN"],
          kind: "stdio",
        },
      },
      status: "failed",
      toolCount: 0,
    });
  });

  it("closes a connected client even when its tools() listing fails", async () => {
    const close = vi.fn(() => Promise.resolve());
    createMCPClient.mockResolvedValueOnce({
      close,
      onElicitationRequest: vi.fn(),
      tools: () => Promise.reject(new Error("list failed")),
    });
    const client = new McpClient(remote("bad", "http://bad/mcp"));
    await client.connect();

    expect(client.status).toBe("failed");
    await client[Symbol.asyncDispose]();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("McpClient transports", () => {
  it("always rejects redirects on remote transports (SSRF guard) and advertises elicitation", async () => {
    createMCPClient.mockResolvedValueOnce(fakeClient(["search"]).client);
    const client = new McpClient(remote("github", "http://x/mcp"));

    await client.connect();

    expect(createMCPClient).toHaveBeenCalledWith({
      capabilities: { elicitation: {} },
      transport: { redirect: "error", type: "http", url: "http://x/mcp" },
    });
  });

  it("forwards sse transport, headers, and authProvider", async () => {
    createMCPClient.mockResolvedValueOnce(fakeClient(["search"]).client);
    const authProvider = { tokens: () => undefined } as never;
    const client = new McpClient({
      id: "svc",
      transport: {
        authProvider,
        headers: { Authorization: "Bearer t" },
        kind: "remote",
        protocol: "sse",
        url: "http://x/sse",
      },
    });

    await client.connect();

    expect(createMCPClient).toHaveBeenCalledWith({
      capabilities: { elicitation: {} },
      transport: {
        authProvider,
        headers: { Authorization: "Bearer t" },
        redirect: "error",
        type: "sse",
        url: "http://x/sse",
      },
    });
  });

  it("hands a stdio definition's resolved config to the spawn seam", async () => {
    createMCPClient.mockResolvedValueOnce(fakeClient(["search"]).client);
    const transport = {
      args: ["-y", "server"],
      command: "npx",
      cwd: "/workspace",
      env: { API_KEY: "secret" },
      kind: "stdio" as const,
    };
    const client = new McpClient({ id: "local", transport }, { spawnStdio });

    await client.connect();

    expect(spawnStdio).toHaveBeenCalledWith(
      transport,
      expect.objectContaining({})
    );
  });

  it("fails cleanly with an explicit Node adapter error when a stdio server connects without spawnStdio", async () => {
    const client = new McpClient({
      id: "local",
      transport: { command: "npx", kind: "stdio" },
    });

    await client.connect();

    expect(client.status).toBe("failed");
    expect(client.error).toContain("spawnStdioTransport");
    expect(client.error).toContain("createNodeMcpClient");
    expect(client.error).toContain("@foundry/agents/node");
    expect(createMCPClient).not.toHaveBeenCalled();
  });
});

describe("McpClient tagged tools", () => {
  it('returns namespaced tools tagged source "mcp" with an exact mcp.tool capability', async () => {
    createMCPClient.mockResolvedValueOnce(fakeClient(["search"]).client);
    const client = new McpClient(remote("github", "http://gh/mcp"));
    await client.connect();

    const search = client.tools().github__search;
    if (!search) {
      throw new Error("expected github__search");
    }
    const meta = metaOf(search);
    expect(meta.source).toBe("mcp");
    expect(meta.capability?.({}, {} as never)).toEqual({
      kind: "mcp.tool",
      serverId: "github",
      tool: "search",
    });
  });

  it("preserves the underlying tool — schema and execute carry through unwrapped", async () => {
    const raw = fakeClient(["search"]);
    createMCPClient.mockResolvedValueOnce(raw.client);
    const client = new McpClient(remote("github", "http://gh/mcp"));
    await client.connect();

    const tagged = client.tools().github__search;
    const originalTool = await raw.client.tools().then((t) => t.search);

    expect(tagged?.execute).toBe(originalTool?.execute);
    expect(tagged?.inputSchema).toBe(originalTool?.inputSchema);
    const result: unknown = await tagged?.execute?.(
      { q: "x" },
      { context: undefined, messages: [], toolCallId: "c1" }
    );
    expect(result).toEqual({ ok: "search" });
  });
});
