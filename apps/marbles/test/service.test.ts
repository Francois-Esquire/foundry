import { resolve } from "node:path";
import { createClient } from "@libsql/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { drizzle } from "drizzle-orm/libsql";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations } from "~/database/migrate-core";
import { PORTABLE_OWNER_LIVENESS } from "~/lib/owner-liveness";
import { createMcpServer } from "~/mcp/server";
import { NotHostedError } from "~/model/errors";
import { MarblesError, toMarblesError } from "~/service/errors";
import { createMarblesService } from "~/service/marbles";
import { MemoryMarblesStorage } from "~/storage/memory";
import type { MarblesStorage } from "~/storage/ports";
import { SqliteMarblesStorage } from "~/storage/sqlite";

const NODE_BUILTIN =
  /^(?:node:|bun:|(?:assert|async_hooks|buffer|child_process|cluster|crypto|dgram|dns|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|timers|tls|tty|url|util|v8|vm|worker_threads|zlib)(?:\/|$))/;

const closers: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});

async function sqliteStorage(): Promise<MarblesStorage> {
  const client = createClient({ url: ":memory:" });
  const database = drizzle({ client });
  await applyMigrations(database, {
    file: ":memory:",
    foreignKeys: async (enabled) => {
      await client.execute(`PRAGMA foreign_keys = ${enabled ? "ON" : "OFF"}`);
    },
  });
  return new SqliteMarblesStorage({
    close: () => {
      client.close();
    },
    database,
    liveness: PORTABLE_OWNER_LIVENESS,
  });
}

const STORAGES: readonly [string, () => Promise<MarblesStorage>][] = [
  ["MemoryMarblesStorage", async () => new MemoryMarblesStorage()],
  ["SqliteMarblesStorage", sqliteStorage],
];

async function seeded(
  create: () => Promise<MarblesStorage>
): Promise<MarblesStorage> {
  const storage = await create();
  closers.push(() => storage.close?.());
  for (const id of ["ws-b", "ws-a"]) {
    await storage.workspaces.touch({ id, root: `/workspace/${id}` }, null, {
      hosted: true,
    });
  }
  return storage;
}

describe.each(STORAGES)("createMarblesService over %s", (_name, create) => {
  it("lists stored workspaces as stopped, sorted by id", async () => {
    const service = createMarblesService({ storage: await seeded(create) });
    expect(await service.workspaces.list()).toEqual([
      { config: null, id: "ws-a", root: "/workspace/ws-a", state: "stopped" },
      { config: null, id: "ws-b", root: "/workspace/ws-b", state: "stopped" },
    ]);
    expect(await service.workspaces.get("ws-b")).toMatchObject({
      id: "ws-b",
      state: "stopped",
    });
    expect(await service.workspaces.get("missing")).toBeUndefined();
  });

  it("merges live workspaces over stored ones", async () => {
    const service = createMarblesService({
      execution: {
        hosted: () => Promise.reject(new Error("unused")),
        workspaces: async () => [
          { config: "src", id: "ws-b", root: "/live/ws-b", state: "ready" },
          { config: null, id: "ws-0", root: "/live/ws-0", state: "starting" },
        ],
      },
      storage: await seeded(create),
    });
    expect(
      (await service.workspaces.list()).map(({ id, state }) => [id, state])
    ).toEqual([
      ["ws-b", "ready"],
      ["ws-0", "starting"],
      ["ws-a", "stopped"],
    ]);
  });

  it("changes, lists and gets tasks from stored state", async () => {
    const service = createMarblesService({ storage: await seeded(create) });
    const changed = await service.tasks.change("ws-a", {
      operations: [
        { input: { title: "Work" }, key: "work", kind: "task.create" },
      ],
    });
    const id = changed.tasks[0]?.id ?? "";
    expect((await service.tasks.list("ws-a")).items).toMatchObject([
      { id, title: "Work" },
    ]);
    expect((await service.tasks.list("ws-b")).items).toEqual([]);
    expect(await service.tasks.get("ws-a", id)).toMatchObject({ id });
    expect(await service.tasks.get("ws-b", id)).toBeUndefined();
  });

  it("delegates tasks to the execution backend when it runs them", async () => {
    const seen: string[] = [];
    const service = createMarblesService({
      execution: {
        hosted: () => Promise.reject(new Error("unused")),
        tasks: (workspaceId, command) => {
          seen.push(`${workspaceId}:${command.kind}`);
          return Promise.reject(new Error("delegated"));
        },
        workspaces: async () => [],
      },
      storage: await seeded(create),
    });
    await expect(service.tasks.list("ws-a")).rejects.toThrow("delegated");
    expect(seen).toEqual(["ws-a:list"]);
  });

  it("projects artifacts with their files", async () => {
    const storage = await seeded(create);
    const artifact = await (
      await storage.forWorkspace("ws-a")
    ).artifacts.create({
      entries: { "hello.txt": { bytes: "hello" } },
      name: "file",
      type: "document",
    });
    await storage.share(
      { id: artifact.id, kind: "artifact", owner: "ws-a" },
      "ws-b"
    );
    const service = createMarblesService({ storage });
    const [listed] = await service.artifacts.list({ workspace: "ws-b" });
    expect(listed).toEqual({
      id: artifact.id,
      name: "file",
      owner: "ws-a",
      sharedWith: ["ws-b"],
      status: artifact.status,
      type: "document",
      updatedAt: artifact.updatedAt.toISOString(),
    });
    expect(
      await service.artifacts.get({ workspace: "ws-a" }, artifact.id)
    ).toMatchObject({ files: [{ path: "hello.txt" }], id: artifact.id });
    expect(
      await service.resources.get("artifact", { all: true }, artifact.id)
    ).toMatchObject({ id: artifact.id });
    expect(
      await service.artifacts.get({ workspace: "ws-a" }, "missing")
    ).toBeUndefined();
  });

  it("projects sessions with message tallies", async () => {
    const storage = await seeded(create);
    await (await storage.forWorkspace("ws-a")).sessions.commit({
      putMessages: [
        {
          createdAt: 1,
          id: "m1",
          parts: [],
          role: "summary",
          sessionId: "s1",
          status: "complete",
          updatedAt: 1,
        },
      ],
      putSessions: [1, 2].map((at) => ({
        createdAt: at,
        id: `s${at}`,
        parentMessageId: null,
        parentSessionId: null,
        status: "active",
        title: null,
        updatedAt: at,
      })),
    });
    const service = createMarblesService({ storage });
    expect(await service.sessions.list({ workspace: "ws-a" })).toEqual([
      {
        id: "s2",
        messages: 0,
        owner: "ws-a",
        sharedWith: [],
        summarized: false,
        updatedAt: new Date(2).toISOString(),
      },
      {
        id: "s1",
        messages: 1,
        owner: "ws-a",
        sharedWith: [],
        summarized: true,
        updatedAt: new Date(1).toISOString(),
      },
    ]);
    expect(
      await service.sessions.get({ workspace: "ws-a" }, "s1")
    ).toMatchObject({ messages: 1, summarized: true });
    expect(await service.sessions.list({ workspace: "ws-b" })).toEqual([]);
  });

  it("projects sandboxes", async () => {
    const storage = await seeded(create);
    await (await storage.forWorkspace("ws-a")).containers.commit({
      putContainers: [
        {
          createdAt: 5,
          id: "box",
          nativeId: undefined,
          spec: "{}",
          status: "stopped",
          updatedAt: 5,
        },
      ],
    });
    const service = createMarblesService({ storage });
    expect(await service.sandboxes.list({ all: true })).toEqual([
      {
        createdAt: new Date(5).toISOString(),
        id: "box",
        owner: "ws-a",
        sharedWith: [],
        status: "stopped",
      },
    ]);
    expect(
      await service.sandboxes.get({ workspace: "ws-b" }, "box")
    ).toBeUndefined();
  });

  it("projects runs with their steps", async () => {
    const storage = await seeded(create);
    const stores = await storage.forWorkspace("ws-a");
    await Effect.runPromise(
      stores.queue.commit({
        jobs: [
          {
            createdAt: 3,
            handler: { name: "work" },
            id: "jb-1",
            input: null,
            links: {},
            policy: {},
            pool: "default",
            state: { kind: "pending" },
          },
        ],
        runs: [
          {
            attempt: 1,
            id: "rn-1",
            jobId: "jb-1",
            pool: "default",
            revision: 0,
            state: { availableAt: 3, kind: "queued", queuedAt: 3 },
          },
        ],
      })
    );
    const service = createMarblesService({ storage });
    const [run] = await service.runs.list({ workspace: "ws-a" });
    expect(run).toMatchObject({
      id: "rn-1",
      owner: "ws-a",
      sharedWith: [],
      steps: expect.any(Array),
    });
    expect(await service.runs.get({ workspace: "ws-a" }, "rn-1")).toEqual(run);
    expect(
      await service.runs.get({ workspace: "ws-b" }, "rn-1")
    ).toBeUndefined();
    expect(await service.runs.list({ workspace: "ws-a" }, 0)).toEqual([]);
  });

  it("refuses hosted work without an execution backend", async () => {
    const service = createMarblesService({ storage: await seeded(create) });
    await expect(service.workspaces.definitions("ws-a")).rejects.toBeInstanceOf(
      NotHostedError
    );
    await expect(
      service.runs.enqueue("ws-a", "work", undefined)
    ).rejects.toBeInstanceOf(NotHostedError);
    await expect(service.runs.cancel("ws-a", "rn-1")).rejects.toBeInstanceOf(
      NotHostedError
    );
    await expect(
      service.agents.dispatch("ws-a", { prompt: "hi" })
    ).rejects.toBeInstanceOf(NotHostedError);
  });

  it("serves MCP list and change_tasks from storage alone", async () => {
    const service = createMarblesService({ storage: await seeded(create) });
    const server = createMcpServer(service.toMcpOptions("ws-a"));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "marbles-test", version: "1.0.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    closers.push(async () => {
      await client.close();
      await server.close();
    });
    const call = async (name: string, args: Record<string, unknown>) =>
      CallToolResultSchema.parse(
        await client.callTool({ arguments: args, name })
      );

    const workspaces = await call("list", { resource: "workspaces" });
    expect(workspaces.structuredContent).toMatchObject({
      items: [
        { id: "ws-a", state: "stopped" },
        { id: "ws-b", state: "stopped" },
      ],
      total: 2,
    });
    const changed = await call("change_tasks", {
      operations: [
        { input: { title: "Via MCP" }, key: "mcp", kind: "task.create" },
      ],
    });
    expect(changed.isError).not.toBe(true);
    const tasks = await call("list", { resource: "tasks" });
    expect(tasks.structuredContent).toMatchObject({
      items: [{ title: "Via MCP" }],
    });
    const other = await call("list", { resource: "tasks", workspace: "ws-b" });
    expect(other.structuredContent).toMatchObject({ items: [] });
    const definitions = await call("list", { resource: "definitions" });
    expect(definitions.isError).toBe(true);
  });
});

describe("toMarblesError", () => {
  it("maps known failures to service codes", () => {
    const busy = new Error("locked");
    busy.name = "DatabaseBusyError";
    expect(toMarblesError(new NotHostedError("x")).code).toBe("not_hosted");
    expect(toMarblesError(busy).code).toBe("busy");
    expect(toMarblesError("odd").code).toBe("failed");
    const own = new MarblesError("conflict", "taken");
    expect(toMarblesError(own)).toBe(own);
  });
});

describe("portable service bundle", () => {
  it("bundles the service, memory storage and MCP server with zero Node built-ins", async () => {
    const workspaceRoot = resolve(import.meta.dirname, "../../..");
    const entry = resolve(import.meta.dirname, "__service-portable-smoke__.ts");
    const source = (path: string) =>
      JSON.stringify(resolve(import.meta.dirname, "../src", path));
    const forbidden: string[] = [];
    const built = await globalThis.Bun.build({
      entrypoints: [entry],
      files: {
        [entry]: [
          `export { createMarblesService } from ${source("service/marbles.ts")};`,
          `export { toMarblesError } from ${source("service/errors.ts")};`,
          `export { MemoryMarblesStorage } from ${source("storage/memory.ts")};`,
          `export { createMcpServer } from ${source("mcp/server.ts")};`,
        ].join("\n"),
      },
      format: "esm",
      minify: false,
      plugins: [
        {
          name: "forbid-node-builtins",
          setup(build) {
            build.onResolve({ filter: NODE_BUILTIN }, (args) => {
              forbidden.push(`${args.importer} -> ${args.path}`);
              return { external: true, path: args.path };
            });
          },
        },
      ],
      root: workspaceRoot,
      target: "browser",
    });
    expect(forbidden).toEqual([]);
    expect(built.success).toBe(true);
  });
});
