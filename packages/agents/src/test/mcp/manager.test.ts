import { tool } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const createMCPClient = vi.fn();
vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient,
  ElicitationRequestSchema: {},
}));
/** The stdio seam; the mocked client never starts what it returns. */
const spawnStdio = vi.fn((config: unknown) => ({ config }) as never);

const { McpClient, McpManager } = await import("../../mcp");
const { metaOf } = await import("../../harness/types");

/** A fake SDK client returning the named tools, with a spyable `close`. */
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

describe("McpManager", () => {
  it("connects an enabled definition on define and prefixes its tools", async () => {
    createMCPClient.mockResolvedValueOnce(fakeClient(["search"]).client);
    const mcp = new McpManager();

    mcp.define(remote("github", "http://gh/mcp"));
    const tools = await mcp.tools();

    expect(Object.keys(tools)).toEqual(["github__search"]);
    expect(mcp.status()).toEqual([
      expect.objectContaining({
        enabled: true,
        id: "github",
        status: "connected",
        toolCount: 1,
      }),
    ]);
  });

  it("registers a disabled definition without connecting", async () => {
    const mcp = new McpManager();
    mcp.define(remote("off", "http://off/mcp", false));

    expect(await mcp.tools()).toEqual({});
    expect(createMCPClient).not.toHaveBeenCalled();
    expect(mcp.status()[0]).toMatchObject({ enabled: false, status: "off" });
    expect(mcp.definitions()).toEqual([remote("off", "http://off/mcp", false)]);
  });

  it("enable connects and disable closes", async () => {
    const a = fakeClient(["a"]);
    createMCPClient.mockResolvedValueOnce(a.client);
    const mcp = new McpManager();
    mcp.define(remote("a", "http://a/mcp", false));

    await mcp.enable("a");
    expect(Object.keys(await mcp.tools())).toEqual(["a__a"]);

    await mcp.disable("a");
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(mcp.client("a")?.status).toBe("off");
    expect(mcp.client("a")?.enabled).toBe(false);
    expect(await mcp.tools()).toEqual({});
  });

  it("pools: repeated tools() never reconnects", async () => {
    createMCPClient.mockResolvedValueOnce(fakeClient(["a"]).client);
    const mcp = new McpManager();
    mcp.define(remote("a", "http://a/mcp"));

    const first = await mcp.tools();
    const second = await mcp.tools();

    expect(createMCPClient).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("reconnects when a redefinition changes connection detail", async () => {
    const v1 = fakeClient(["a"]);
    const v2 = fakeClient(["a"]);
    createMCPClient
      .mockResolvedValueOnce(v1.client)
      .mockResolvedValueOnce(v2.client);
    const mcp = new McpManager();

    mcp.define(remote("a", "http://a/mcp"));
    await mcp.tools();
    mcp.define(remote("a", "http://a/v2/mcp"));
    await mcp.tools();

    expect(v1.close).toHaveBeenCalledTimes(1);
    expect(createMCPClient).toHaveBeenCalledTimes(2);
  });

  it("keeps the connection when only metadata changes", async () => {
    createMCPClient.mockResolvedValueOnce(fakeClient(["a"]).client);
    const mcp = new McpManager();

    mcp.define({ ...remote("a", "http://a/mcp"), name: "A" });
    await mcp.tools();
    mcp.define({ ...remote("a", "http://a/mcp"), name: "A renamed" });
    await mcp.tools();

    expect(createMCPClient).toHaveBeenCalledTimes(1);
    expect(mcp.client("a")?.definition.name).toBe("A renamed");
  });

  it("restarts a stdio client when its resolved environment changes", async () => {
    const v1 = fakeClient(["a"]);
    const v2 = fakeClient(["a"]);
    createMCPClient
      .mockResolvedValueOnce(v1.client)
      .mockResolvedValueOnce(v2.client);
    const mcp = new McpManager({ spawnStdio });
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

    mcp.define(local("one"));
    await mcp.tools();
    mcp.define(local("two"));
    await mcp.tools();

    expect(v1.close).toHaveBeenCalledTimes(1);
    expect(spawnStdio).toHaveBeenLastCalledWith(
      local("two").transport,
      expect.objectContaining({})
    );
  });

  it("closes and drops a removed definition", async () => {
    const a = fakeClient(["a"]);
    createMCPClient.mockResolvedValueOnce(a.client);
    const mcp = new McpManager();
    mcp.define(remote("a", "http://a/mcp"));
    await mcp.tools();

    await mcp.remove("a");

    expect(a.close).toHaveBeenCalledTimes(1);
    expect(mcp.status()).toEqual([]);
    expect(mcp.client("a")).toBeUndefined();
  });

  it("degrades gracefully when one client fails to connect", async () => {
    createMCPClient
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValueOnce(fakeClient(["b"]).client);
    const mcp = new McpManager();
    const failed = vi.fn();
    mcp.on("status", (c) => {
      if (c.status === "failed") {
        failed(c.id, c.error);
      }
    });
    mcp.define(remote("down", "http://down/mcp"));
    mcp.define(remote("up", "http://up/mcp"));

    const tools = await mcp.tools();

    expect(Object.keys(tools)).toEqual(["up__b"]);
    expect(mcp.client("down")?.state()).toMatchObject({
      error: "refused",
      status: "failed",
    });
    expect(failed).toHaveBeenCalledWith("down", "refused");
  });

  it("retries a failed client only after the cooldown elapses", async () => {
    vi.useFakeTimers();
    try {
      createMCPClient
        .mockRejectedValueOnce(new Error("refused"))
        .mockResolvedValueOnce(fakeClient(["a"]).client);
      const mcp = new McpManager({ retryCooldownMs: 1000 });
      mcp.define(remote("a", "http://a/mcp"));

      await mcp.tools();
      expect(mcp.client("a")?.status).toBe("failed");
      expect(createMCPClient).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(500);
      await mcp.tools();
      expect(createMCPClient).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(600);
      const tools = await mcp.tools();
      expect(createMCPClient).toHaveBeenCalledTimes(2);
      expect(Object.keys(tools)).toEqual(["a__a"]);
      expect(mcp.client("a")?.status).toBe("connected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("redefining a failed client unchanged leaves it to its cooldown", async () => {
    createMCPClient.mockRejectedValue(new Error("refused"));
    const mcp = new McpManager({ retryCooldownMs: 60_000 });
    mcp.define(remote("a", "http://a/mcp"));
    await mcp.tools();
    expect(createMCPClient).toHaveBeenCalledTimes(1);

    mcp.define(remote("a", "http://a/mcp"));
    await mcp.tools();

    expect(createMCPClient).toHaveBeenCalledTimes(1);
  });

  it("re-enabling a failed client retries immediately", async () => {
    createMCPClient
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValueOnce(fakeClient(["a"]).client);
    const mcp = new McpManager({ retryCooldownMs: 60_000 });
    mcp.define(remote("a", "http://a/mcp"));
    await mcp.tools();

    await mcp.disable("a");
    await mcp.enable("a");

    expect(createMCPClient).toHaveBeenCalledTimes(2);
    expect(mcp.client("a")?.status).toBe("connected");
  });

  it("redacts resolved environment values from errors and summaries", async () => {
    createMCPClient.mockRejectedValueOnce(new Error("bad secret-token"));
    const mcp = new McpManager({ spawnStdio });
    mcp.define({
      enabled: true,
      id: "local",
      transport: {
        command: "node",
        env: { TOKEN: "secret-token" },
        kind: "stdio",
      },
    });
    await mcp.tools();

    expect(mcp.status()[0]).toEqual({
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
    const mcp = new McpManager();
    mcp.define(remote("bad", "http://bad/mcp"));
    await mcp.tools();

    expect(mcp.client("bad")?.status).toBe("failed");
    await mcp[Symbol.asyncDispose]();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes every client on dispose", async () => {
    const a = fakeClient(["a"]);
    const b = fakeClient(["b"]);
    createMCPClient
      .mockResolvedValueOnce(a.client)
      .mockResolvedValueOnce(b.client);
    const mcp = new McpManager();
    mcp.define(remote("a", "http://a/mcp"));
    mcp.define(remote("b", "http://b/mcp"));
    await mcp.tools();

    await mcp[Symbol.asyncDispose]();

    expect(a.close).toHaveBeenCalledTimes(1);
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(mcp.clients()).toEqual([]);
  });

  it("forwards client events and stops after remove", async () => {
    createMCPClient.mockResolvedValueOnce(fakeClient(["a"]).client);
    const mcp = new McpManager();
    const statuses: string[] = [];
    mcp.on("status", (c) => statuses.push(`${c.id}:${c.status}`));
    mcp.define(remote("a", "http://a/mcp"));
    await mcp.tools();

    expect(statuses).toEqual(["a:connecting", "a:connected"]);
    await mcp.remove("a");
    expect(statuses).toEqual(["a:connecting", "a:connected"]);
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

  it("connect() on a disabled definition still connects; the manager's tools() ignores it", async () => {
    createMCPClient.mockResolvedValueOnce(fakeClient(["a"]).client);
    const mcp = new McpManager();
    const client = mcp.define(remote("a", "http://a/mcp", false));

    await client.connect();

    expect(client.status).toBe("connected");
    expect(await mcp.tools()).toEqual({});
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
