import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const NODE_BUILTIN =
  /^(?:node:|bun:|(?:assert|async_hooks|buffer|child_process|cluster|crypto|dgram|dns|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|timers|tls|tty|url|util|v8|vm|worker_threads|zlib)(?:\/|$))/;

const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../..");
const MARBLES_DIST_INDEX = resolve(import.meta.dirname, "../dist/index.js");
const MARBLES_DIST_LIB = resolve(import.meta.dirname, "../dist/lib.js");
const VIRTUAL_ENTRY = resolve(import.meta.dirname, "__v8-isolate-smoke__.ts");

const SMOKE_ENTRY = `
import { FOUNDRY_PATHS, resolvePathTemplates } from "@foundry/core/paths";
import { runAfterCommit } from "@foundry/core/storage";
import { generateId } from "@foundry/lib/id";
import { pageAfter } from "@foundry/lib/pagination";
import { Prompt, prompts } from "@foundry/prompts";
import { createUsage } from "@foundry/usage";
import { Models, formatSelection } from "@foundry/models";
import { Workspaces } from "@foundry/workspaces";
import { MemoryWorkspaceStore } from "@foundry/workspaces/store/memory";
import { Artifacts } from "@foundry/artifacts";
import { MemoryArtifactStore } from "@foundry/artifacts/store/memory";
import { Tasks } from "@foundry/tasks";
import { MemoryTaskStore } from "@foundry/tasks/store/memory";
import { Modules } from "@foundry/modules";
import { MemoryModuleStore } from "@foundry/modules/store/memory";
import { Sessions } from "@foundry/agents";
import { MemorySessionStore } from "@foundry/agents/store/memory";
import { normalizeSandboxPath } from "@foundry/sandbox";
import { MemoryContainerStore } from "@foundry/sandbox/store/memory";
import { Workflow } from "@foundry/workflows";
import {
  claimRun,
  enqueueJob,
  settleRun,
} from "@foundry/queue";
import { makeMemoryQueueStore } from "@foundry/queue/store/memory";
import { evaluateDueSchedules } from "@foundry/scheduling";
import { statelessQueueDispatch } from "@foundry/scheduling/queue";
import { makeMemoryScheduleStore } from "@foundry/scheduling/store/memory";
import { Effect, Exit } from "effect";
import { defineWorkspace, step, workflow } from ${JSON.stringify(MARBLES_DIST_INDEX)};
import {
  CommandError,
  createPortableContextRuntime,
  Engine as MarblesEngine,
  installContextRuntime,
  MemoryRunOutputSink,
  PORTABLE_OWNER_LIVENESS,
  parseArgv,
} from ${JSON.stringify(MARBLES_DIST_LIB)};

globalThis.__smokeResult = (async () => {
  for (const forbidden of [
    "process",
    "Buffer",
    "Bun",
    "require",
    "module",
    "exports",
    "__dirname",
    "__filename",
    "setImmediate",
    "clearImmediate",
  ]) {
    if (forbidden in globalThis) {
      throw new Error(\`\${forbidden} leaked into isolate\`);
    }
  }

  const id = generateId({ prefix: "iso" });
  const page = pageAfter(["a", "b", "c"], { limit: 2 }, (item) => item);
  const paths = resolvePathTemplates(FOUNDRY_PATHS, { FOUNDRY_ROOT: "/virtual" });
  let committed = false;
  await runAfterCommit([() => { committed = true; }]);

  const renderedPrompt = prompts.claude("hello isolate").text;
  const promptApiType = typeof Prompt;

  const usage = createUsage({ providers: [] });
  const models = new Models();
  const formattedModel = formatSelection({ model: "gpt-5", provider: "openai" });

  const workspaces = new Workspaces({ store: new MemoryWorkspaceStore() });
  const listedWorkspaces = await workspaces.list();

  const artifacts = new Artifacts({ store: new MemoryArtifactStore() });
  const createdArtifact = await artifacts.create({
    entries: { "hello.txt": { bytes: "world" } },
    name: "smoke",
    type: "text/plain",
  });

  const tasks = new Tasks({ store: new MemoryTaskStore() });
  const createdTask = await tasks.create({ title: "isolate task" });

  const modules = new Modules({ store: new MemoryModuleStore() });
  const listedModules = await modules.listModules();

  const sessions = new Sessions({ store: new MemorySessionStore() });
  const session = await sessions.createSession({ title: "isolate session" });

  const sandboxStore = new MemoryContainerStore();
  const sandboxPath = normalizeSandboxPath("src/index.ts");
  const sandboxRows = await sandboxStore.list();

  const wf = Workflow.create({
    execute: async (input) => input * 2,
    input: 21,
    name: "smoke-wf",
  });
  const wfOutput = await wf.run();
  await wf.dispose();

  const queueResult = await Effect.runPromise(
    Effect.gen(function* () {
      const queueStore = yield* makeMemoryQueueStore;
      const scheduleStore = yield* makeMemoryScheduleStore;
      yield* scheduleStore.commit({
        cursors: [{ nextDueAt: 1000, scheduleId: "smoke-sched" }],
        schedules: [
          {
            cadence: { everyMs: 1000, kind: "interval" },
            createdAt: 0,
            id: "smoke-sched",
            misfire: "run-once",
            overlap: "skip",
            state: "active",
            target: { handler: { name: "smoke" }, input: { ok: true } },
          },
        ],
      });
      const evalResult = yield* evaluateDueSchedules({
        dispatch: statelessQueueDispatch(queueStore),
        now: 1000,
        store: scheduleStore,
      });
      const directJob = yield* enqueueJob(queueStore, {
        handler: { name: "direct" },
        input: "hi",
      });
      const claimed = yield* claimRun(queueStore, { handlerNames: ["direct"] });
      if (claimed === undefined) throw new Error("expected claimed direct run");
      yield* settleRun(
        queueStore,
        claimed.run.id,
        claimed.lease,
        Exit.succeed({ kind: "complete", output: "done" })
      );
      const settled = yield* queueStore.getJob(directJob.id);
      return {
        decidedCount: evalResult.decided.length,
        directKind: settled?.state.kind,
        soonest: evalResult.soonest,
      };
    })
  );

  const marblesStep = step("greet").do(async () => "hi v8");
  const marblesWf = workflow("pipeline").do(() => marblesStep());
  const marblesWorkspace = defineWorkspace({
    definitions: [marblesStep, marblesWf],
  });

  installContextRuntime(createPortableContextRuntime());
  const parsedArgv = parseArgv("echo 'hello world'");
  const commandError = new CommandError(["echo"], { exitCode: 1, stderr: "boom", stdout: "" });

  const marblesOutput = new MemoryRunOutputSink();
  const marblesEngine = new MarblesEngine({
    artifacts: new Artifacts({ store: new MemoryArtifactStore() }),
    containers: () => Promise.reject(new Error("no sandbox in isolate")),
    liveness: PORTABLE_OWNER_LIVENESS,
    models: new Models(),
    outputSink: marblesOutput,
    print: () => undefined,
    root: "/virtual/marbles",
    sessions: new MemorySessionStore(),
    workspaceId: "isolate-ws",
  });
  marblesEngine.define(marblesStep);
  marblesEngine.define(marblesWf);
  await marblesEngine.start();
  const marblesRunOutput = await marblesEngine.run("pipeline", undefined);
  await marblesEngine.dispose();

  return {
    artifactId: createdArtifact.id,
    commandErrorOk: commandError instanceof CommandError && commandError.result.exitCode === 1,
    committed,
    formattedModel,
    idPrefix: id.startsWith("iso_"),
    marblesItems: marblesWorkspace.input.definitions?.length ?? 0,
    marblesRunOutput,
    modelsReady: Array.isArray(models.providers),
    modulesCount: listedModules.items.length,
    pageItems: page.items,
    parsedArgvCount: parsedArgv.length,
    pathsMarbles: paths.marbles,
    promptApiType,
    queueResult,
    renderedPrompt,
    sandboxPath,
    sandboxRows: sandboxRows.length,
    sessionId: session.id,
    taskId: createdTask.id,
    usageReady: typeof usage.query === "function",
    wfOutput,
    workspacesCount: listedWorkspaces.items.length,
  };
})();
`;

const VM_STRUCTURED_CLONE = `
globalThis.structuredClone = (value) => {
  const clone = (input, seen) => {
    if (input === null || typeof input !== "object") return input;
    if (seen.has(input)) return seen.get(input);
    if (input instanceof Date) return new Date(input.getTime());
    if (input instanceof RegExp) return new RegExp(input.source, input.flags);
    if (ArrayBuffer.isView(input)) {
      if (input instanceof Uint8Array) return new Uint8Array(input);
      return new input.constructor(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
    }
    if (Array.isArray(input)) {
      const out = [];
      seen.set(input, out);
      for (const item of input) out.push(clone(item, seen));
      return out;
    }
    if (input instanceof Map) {
      const out = new Map();
      seen.set(input, out);
      for (const [k, v] of input) out.set(clone(k, seen), clone(v, seen));
      return out;
    }
    if (input instanceof Set) {
      const out = new Set();
      seen.set(input, out);
      for (const v of input) out.add(clone(v, seen));
      return out;
    }
    const out = Object.getPrototypeOf(input) === null ? Object.create(null) : {};
    seen.set(input, out);
    for (const key of Object.keys(input)) out[key] = clone(input[key], seen);
    return out;
  };
  return clone(value, new Map());
};
`;

const NODE_VM_RUNNER = `
const fs = require("node:fs");
const vm = require("node:vm");
const code = fs.readFileSync(0, "utf8");
const context = vm.createContext({
  AbortController,
  AbortSignal,
  atob,
  Blob,
  btoa,
  CompressionStream,
  Crypto,
  CustomEvent,
  clearInterval,
  clearTimeout,
  console,
  crypto,
  DecompressionStream,
  DOMException,
  Event,
  EventTarget,
  File,
  FormData,
  fetch,
  Headers,
  Intl,
  performance,
  queueMicrotask,
  ReadableStream,
  Request,
  Response,
  setInterval,
  setTimeout,
  TextDecoder,
  TextEncoder,
  TransformStream,
  URL,
  URLSearchParams,
  WritableStream,
});
context.globalThis = context;
context.self = context;
vm.runInContext(${JSON.stringify(VM_STRUCTURED_CLONE)}, context);
vm.runInContext(code, context, { filename: "v8-isolate-smoke.js" });
Promise.resolve(context.__smokeResult).then(
  (result) => {
    process.stdout.write(JSON.stringify(result));
  },
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
`;

function runInNodeV8Isolate(code: string): Record<string, unknown> {
  const stdout = execFileSync("node", ["-e", NODE_VM_RUNNER], {
    encoding: "utf8",
    input: code,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("Non-Node V8 isolate smoke test", () => {
  test("NODE_BUILTIN matches node:, bun:, and bare Node built-in specifiers", () => {
    expect(NODE_BUILTIN.test("node:fs")).toBe(true);
    expect(NODE_BUILTIN.test("node:path/posix")).toBe(true);
    expect(NODE_BUILTIN.test("bun:sqlite")).toBe(true);
    expect(NODE_BUILTIN.test("fs")).toBe(true);
    expect(NODE_BUILTIN.test("fs/promises")).toBe(true);
    expect(NODE_BUILTIN.test("@foundry/lib/id")).toBe(false);
  });
  test("all portable package entries and Marbles authoring bundle cleanly with zero Node built-ins and execute in a Web-standard VM context", async () => {
    const forbiddenImports: string[] = [];

    const built = await globalThis.Bun.build({
      entrypoints: [VIRTUAL_ENTRY],
      files: {
        [VIRTUAL_ENTRY]: SMOKE_ENTRY,
      },
      format: "iife",
      minify: false,
      plugins: [
        {
          name: "forbid-node-builtins",
          setup(build) {
            build.onResolve({ filter: NODE_BUILTIN }, (args) => {
              forbiddenImports.push(`${args.importer} -> ${args.path}`);
              return {
                external: true,
                path: args.path,
              };
            });
          },
        },
      ],
      root: WORKSPACE_ROOT,
      target: "browser",
    });

    expect(forbiddenImports).toEqual([]);
    expect(built.success).toBe(true);
    const [output] = built.outputs;
    if (output === undefined) {
      throw new Error("Expected bundled output");
    }
    const code = await output.text();
    const result = runInNodeV8Isolate(code);

    expect(result).toMatchObject({
      commandErrorOk: true,
      committed: true,
      formattedModel: "openai/gpt-5",
      idPrefix: true,
      marblesItems: 2,
      marblesRunOutput: "hi v8",
      modelsReady: true,
      modulesCount: 0,
      pageItems: ["a", "b"],
      parsedArgvCount: 2,
      pathsMarbles: "/virtual/marbles",
      promptApiType: "function",
      queueResult: {
        decidedCount: 1,
        directKind: "complete",
        soonest: 2000,
      },
      renderedPrompt: "hello isolate",
      sandboxPath: "/workspace/src/index.ts",
      sandboxRows: 0,
      usageReady: true,
      wfOutput: 42,
      workspacesCount: 0,
    });
    expect(typeof result.artifactId).toBe("string");
    expect(typeof result.sessionId).toBe("string");
    expect(typeof result.taskId).toBe("string");
  }, 30_000);
});
