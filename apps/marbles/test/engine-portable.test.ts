import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { MemorySessionStore } from "@foundry/agents/store/memory";
import { Artifacts } from "@foundry/artifacts";
import { MemoryArtifactStore } from "@foundry/artifacts/store/memory";
import { Models } from "@foundry/models";
import { createQueueClient } from "@foundry/queue/client";
import type { Containers } from "@foundry/sandbox";
import { createSchedulerClient } from "@foundry/scheduling/client";
import { step, workflow } from "@foundry.sh/marbles";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "~/lib/engine";
import { MemoryWorkspaceRecords } from "~/lib/events/records";
import type { OwnerLiveness } from "~/lib/owner-liveness";
import { runScheduler } from "~/lib/schedule-loop";
import { MemoryRunOutputSink } from "~/lib/state/output";

const NODE_BUILTIN =
  /^(?:node:|bun:|(?:assert|async_hooks|buffer|child_process|cluster|crypto|dgram|dns|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|timers|tls|tty|url|util|v8|vm|worker_threads|zlib)(?:\/|$))/;

const ALL_IMPORTS = /.*/;
const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) {
    await engine.dispose();
  }
});

describe("portable Engine execution", () => {
  it("runs a workflow end-to-end with Memory* stores, MemoryRunOutputSink, injected queue/scheduler, and custom owner liveness", async () => {
    const outputSink = new MemoryRunOutputSink();
    const goneOwners = new Set<string>();
    const customIdentity = { pid: 0, started: "worker:portable-1" } as const;
    const isGoneSpy = vi.fn((owner: { readonly started: string | null }) =>
      goneOwners.has(owner.started ?? "")
    );
    const liveness: OwnerLiveness = {
      identity: () => customIdentity,
      isGone: isGoneSpy,
      stateOf: (owner) =>
        goneOwners.has(owner.started ?? "") ? "gone" : "running",
    };

    const queueFactory = vi.fn((options) => createQueueClient(options));
    const schedulerFactory = vi.fn((options) => createSchedulerClient(options));
    const execSpy = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "from-injected-exec\n",
    }));
    const skillsSpy = vi.fn(async () => []);

    const fakeContainers: Containers = {
      get: async () => null,
      list: async () => [],
      recover: async () => ({
        conflicts: [],
        kept: [],
        passedOver: [],
        removed: [],
        swept: [],
      }),
      start: async () => {
        throw new Error("not used");
      },
    } as unknown as Containers;

    const engine = new Engine({
      artifacts: new Artifacts({ store: new MemoryArtifactStore() }),
      commandRunner: () => execSpy,
      containers: fakeContainers,
      createQueueClient: queueFactory,
      environment: { PORTABLE_MODE: "1" },
      leaseTtlMs: 30_000,
      liveness,
      models: new Models(),
      outputSink,
      print: () => undefined,
      readFeedMedia: async () => new Uint8Array(),
      records: new MemoryWorkspaceRecords(),
      root: "/virtual/workspace",
      sessions: new MemorySessionStore(),
      skills: skillsSpy,
      workspaceId: "ws-portable",
      worktrees: "/virtual/worktrees",
    });
    engines.push(engine);

    const runStep = step("greet").do(async (ctx) => {
      const result = await ctx.exec(["echo", "hello"]);
      return `ok:${result.stdout.trim()}`;
    });
    const wf = workflow("portable-wf").do(() => runStep());
    engine.define(runStep);
    engine.define(wf);
    await engine.start();

    expect(queueFactory).toHaveBeenCalledTimes(1);
    const queueCall = queueFactory.mock.calls[0]?.[0];
    expect(queueCall?.leaseTtlMs).toBe(30_000);
    expect(queueCall?.identity).toEqual(customIdentity);

    const launched = await engine.launch<string>("portable-wf", undefined);
    const value = await launched.result;
    expect(value).toBe("ok:from-injected-exec");
    expect(execSpy).toHaveBeenCalledTimes(1);

    const records = outputSink.read(launched.id);
    expect(records[0]).toMatchObject({
      name: "portable-wf",
      pid: 0,
      runId: launched.id,
      started: "worker:portable-1",
      type: "start",
    });
    expect(records.at(-1)).toMatchObject({
      status: "completed",
      type: "end",
    });

    const controller = new AbortController();
    engine.schedule({
      input: null,
      key: "portable-sched",
      kind: "schedule",
      label: "portable-sched",
      trigger: { kind: "interval", ms: 60_000 },
      workflow: "portable-wf",
    });
    const loop = runScheduler(engine, {
      claimTtlMs: 15_000,
      createClient: schedulerFactory,
      liveness,
      print: () => undefined,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(schedulerFactory).toHaveBeenCalledTimes(1));
    controller.abort();
    await loop;

    const schedCall = schedulerFactory.mock.calls[0]?.[0];
    expect(schedCall?.claimTtlMs).toBe(15_000);
    expect(schedCall?.identity).toEqual(customIdentity);
  });

  it("createMcpServer bundles with zero Node built-ins for non-Node runtimes", async () => {
    const workspaceRoot = resolve(import.meta.dirname, "../../..");
    const virtualEntry = resolve(
      import.meta.dirname,
      "__mcp-portable-smoke__.ts"
    );
    const mcpServerPath = resolve(import.meta.dirname, "../src/mcp/server.ts");
    const forbiddenImports: string[] = [];

    const built = await globalThis.Bun.build({
      entrypoints: [virtualEntry],
      external: ["@modelcontextprotocol/sdk"],
      files: {
        [virtualEntry]: `export { createMcpServer } from ${JSON.stringify(mcpServerPath)};`,
      },
      format: "esm",
      minify: false,
      plugins: [
        {
          name: "forbid-node-builtins",
          setup(build) {
            build.onResolve({ filter: NODE_BUILTIN }, (args) => {
              forbiddenImports.push(`${args.importer} -> ${args.path}`);
              return { external: true, path: args.path };
            });
          },
        },
      ],
      root: workspaceRoot,
      target: "browser",
    });

    expect(forbiddenImports).toEqual([]);
    expect(built.success).toBe(true);
  });
});

describe("database store import portability", () => {
  it.each(["stores", "resources", "migrate-core"])(
    "bundles %s for the browser without Node or libsql imports",
    async (entry) => {
      const builtins = new Set(
        builtinModules.map((name) => name.replace("node:", ""))
      );
      const forbidden: string[] = [];
      const built = await globalThis.Bun.build({
        entrypoints: [
          resolve(import.meta.dirname, `../src/database/${entry}.ts`),
        ],
        plugins: [
          {
            name: "database-import-audit",
            setup(build) {
              build.onResolve({ filter: ALL_IMPORTS }, (args) => {
                if (
                  args.path.startsWith("node:") ||
                  builtins.has(args.path) ||
                  args.path.startsWith("@libsql/client")
                ) {
                  forbidden.push(`${args.importer} -> ${args.path}`);
                  return { external: true, path: args.path };
                }
              });
            },
          },
        ],
        target: "browser",
      });
      expect(forbidden).toEqual([]);
      expect(built.logs).toEqual([]);
      expect(built.success).toBe(true);
    }
  );
});
