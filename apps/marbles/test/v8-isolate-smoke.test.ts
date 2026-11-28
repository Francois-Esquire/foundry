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
import {
  isHarnessQuestionTool,
  markHarnessQuestionExecutor,
} from "@foundry/core/agents";
import { FOUNDRY_PATHS, resolvePathTemplates } from "@foundry/core/paths";
import { runAfterCommit } from "@foundry/core/storage";
import { withAbort } from "@foundry/lib/abort";
import { sha256Hex } from "@foundry/lib/digest";
import { TypedEmitter } from "@foundry/lib/emitter";
import { base64ToBytes, bytesToBase64 } from "@foundry/lib/encoding";
import { globToRegExp } from "@foundry/lib/glob";
import { generateId } from "@foundry/lib/id";
import { createInstanceRegistry } from "@foundry/lib/instance-identity";
import { canonicalizeJson } from "@foundry/lib/json";
import { KeyedQueue } from "@foundry/lib/keyed-queue";
import { isTextMime } from "@foundry/lib/mime";
import { byCodeUnit } from "@foundry/lib/ordering";
import { pageAfter } from "@foundry/lib/pagination";
import { plainJson } from "@foundry/lib/plain-json";
import {
  createPortableProcess,
  isProcessIdentity,
  ownerStateOf,
  PORTABLE_OWNER_LIVENESS,
} from "@foundry/lib/process-identity";
import {
  maxBatchRows,
  SQLITE_D1_MAX_PARAMETERS,
  sqliteBytes,
} from "@foundry/lib/sqlite";
import { Turns } from "@foundry/lib/turns";
import {
  assemble,
  claudeCode,
  codex,
  Prompt,
  pi,
  prompts,
} from "@foundry/prompts";
import { createUsage } from "@foundry/usage";
import {
  defineProvider,
  spendCap,
  window as usageWindow,
} from "@foundry/usage/provider";
import { Models, formatSelection } from "@foundry/models";
import { Workspaces } from "@foundry/workspaces";
import { MemoryWorkspaceStore } from "@foundry/workspaces/store/memory";
import { Artifacts } from "@foundry/artifacts";
import { MemoryArtifactStore } from "@foundry/artifacts/store/memory";
import {
  artifactBlobs,
  artifacts as artifactsTable,
} from "@foundry/artifacts/store/tables";
import { Authorization, withPermit } from "@foundry/authorization";
import { MemoryAuthorizationStore } from "@foundry/authorization/store/memory";
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
  recoverExpiredLeases,
  renewLease,
  settleRun,
} from "@foundry/queue";
import { makeMemoryQueueStore } from "@foundry/queue/store/memory";
import {
  DEFAULT_CLAIM_TTL_MS,
  evaluateDueSchedules,
  pauseSchedule,
  registerSchedule,
  resumeSchedule,
  unregisterSchedule,
} from "@foundry/scheduling";
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
  PORTABLE_OWNER_LIVENESS as MARBLES_PORTABLE_OWNER_LIVENESS,
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

  const questionExec = () => Promise.resolve("ok");
  markHarnessQuestionExecutor(questionExec);
  const questionToolMarked = isHarnessQuestionTool({ execute: questionExec });

  const digest = await sha256Hex("isolate");
  const roundTripped = new TextDecoder().decode(
    base64ToBytes(bytesToBase64(new TextEncoder().encode("v8")))
  );
  const globMatched = globToRegExp("src/**/*.ts").test("src/a/b.ts");
  const portable = createPortableProcess({ id: () => "iso-proc", now: () => 0 });
  const portableValid = isProcessIdentity(portable);
  const livenessState = ownerStateOf(PORTABLE_OWNER_LIVENESS, portable);
  const registry = createInstanceRegistry({ id: () => "inst-1" });
  const inst = registry.open(portable);
  const instAlive = !registry.isGone(inst, portable, () => true);
  registry.close(inst);
  const turns = new Turns("reentrant");
  const turnRan = await turns.run(() => Promise.resolve("ok"));
  const keyed = new KeyedQueue();
  const keyedRan = await keyed.run("k", () => Promise.resolve("ok"));
  const abortOk = await withAbort(Promise.resolve("ok"), new AbortController().signal);
  const emitter = new TypedEmitter();
  let emitted = 0;
  emitter.on("ping", () => { emitted += 1; });
  emitter.emit("ping", undefined);
  plainJson("smoke", { ok: true });
  const libChecks = {
    abortOk,
    canonical: canonicalizeJson({ b: 1, a: 2 }),
    d1BatchRows: maxBatchRows(5, SQLITE_D1_MAX_PARAMETERS),
    digestLen: digest.length,
    emitted,
    globMatched,
    instAlive,
    keyedRan,
    livenessState,
    mime: isTextMime("text/markdown"),
    ordered: byCodeUnit((value: string) => value)("a", "b") < 0,
    portableValid,
    questionToolMarked,
    reentrancyGuarded: turns.reentrancyGuarded,
    roundTripped,
    sqliteBytesType: typeof sqliteBytes,
    turnRan,
  };

  const renderedPrompt = prompts.claude("hello isolate").text;
  const promptApiType = typeof Prompt;
  const customPrompts = assemble({
    dialects: { claude: claudeCode, codex, pi },
    sources: [{ skill: ["inspect"] }],
  });
  const plainLayer = { skill: ["extra"] };
  customPrompts.add(plainLayer);
  const plainLayerRemoved = customPrompts.remove(plainLayer);

  const usageClock = () => new Date("2026-10-15T12:00:00Z");
  const usage = createUsage({
    clock: usageClock,
    fetch: async () =>
      new Response(
        JSON.stringify({
          data: [{ results: [{ amount: { currency: "usd", value: 12.5 } }] }],
          has_more: false,
        }),
        { headers: { "content-type": "application/json" }, status: 200 }
      ),
  });
  const smokeProvider = defineProvider({
    credential: ({ id }: { readonly id: string }) => id,
    id: "smoke-provider",
    limits: async () => ({
      limits: [
        usageWindow.weekly({
          resetsAt: new Date("2026-10-20T12:00:00Z"),
          usedPercent: 25,
        }),
        spendCap({
          cap: 100,
          resetsAt: new Date("2026-11-01T00:00:00Z"),
          startsAt: new Date("2026-10-01T00:00:00Z"),
          used: 40,
        }),
      ],
    }),
  });
  const smokeAccount = smokeProvider({ id: "acct-1", name: "smoke-account" });
  const accountName = usage.add(smokeAccount);
  const usageSnapshot = await usage.query(accountName);
  const usageShare = await usage.share(accountName, "weekly");
  const usageBudget = await usage.budget(accountName);
  usage.add({
    billing: {
      adminKey: async () => " sk-smoke-admin ",
      cap: 50,
    },
    name: "smoke-billed",
    provider: "openai",
  });
  const billedBudget = await usage.budget("smoke-billed");
  const usageChecks = {
    billedRemaining: billedBudget?.remaining,
    budgetRemaining: usageBudget?.remaining,
    noCredentialExposed: !("credential" in smokeAccount),
    share: usageShare,
    snapshotName: usageSnapshot.name,
  };

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
  const revised = await artifacts.revise({
    artifactId: createdArtifact.id,
    changes: { put: { "hello.txt": { bytes: "world-2" } } },
    contentId: createdArtifact.content!.id,
    expectedUpdatedAt: createdArtifact.content!.updatedAt,
  });
  const frozen = await artifacts.freeze(revised.id, {
    expectedUpdatedAt: revised.updatedAt,
    tag: "v1",
  });
  const rawBytes = new Uint8Array([1, 2, 3]);
  const mappedOrder = artifactsTable.idOrder.mapFromDriverValue(rawBytes.buffer);
  const mappedBlob = artifactBlobs.bytes.mapFromDriverValue(rawBytes.buffer);
  const artifactTablesOk =
    mappedOrder instanceof Uint8Array &&
    mappedBlob instanceof Uint8Array &&
    mappedBlob.length === 3 &&
    frozen.state === "frozen";

  const auth = new Authorization({ store: new MemoryAuthorizationStore() });
  const principal = { id: "agent-1", kind: "agent" };
  const request = {
    action: "tool.call",
    principal,
    target: "read",
  };
  const issuedGrant = await auth.grant({
    holder: { kind: "exact", principal },
    requestedBy: { id: "user-1", kind: "user" },
    scope: { action: "tool.call", target: { kind: "exact", value: "read" } },
  });
  const beforeRevoke = await auth.check(request);
  const permitRan = await withPermit(
    auth,
    request,
    "inv-smoke-1",
    async (permit) => Boolean(permit.receipt.grantId)
  );
  await auth.revoke({ grantId: issuedGrant.id, kind: "grant" }, "smoke-done");
  const afterRevoke = await auth.check(request);
  const authLifecycle = {
    afterRevoke: afterRevoke.kind,
    beforeRevoke: beforeRevoke.kind,
    permitRan,
  };

  const tasks = new Tasks({ store: new MemoryTaskStore() });
  const createdTask = await tasks.create({ title: "isolate task" });
  const dependentTask = await tasks.create(
    { title: "dependent task" },
    { dependsOn: [{ id: createdTask.id }] }
  );
  const blockedAvail = await tasks.availability(dependentTask.id);
  const readyBefore = await tasks.ready();
  await tasks.remove(dependentTask.id);
  const taskChecks = {
    blockedKind: blockedAvail?.kind,
    readyCount: readyBefore.items.length,
  };

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
      yield* registerSchedule(
        scheduleStore,
        {
          cadence: { everyMs: 1000, kind: "interval" },
          id: "smoke-sched",
          target: { handler: { name: "smoke" }, input: { ok: true } },
        },
        { now: 0 }
      );
      yield* pauseSchedule(scheduleStore, "smoke-sched", { now: 10 });
      yield* resumeSchedule(scheduleStore, "smoke-sched", { now: 20 });

      const evalResult = yield* evaluateDueSchedules({
        dispatch: statelessQueueDispatch(queueStore),
        now: 1000,
        store: scheduleStore,
      });
      yield* unregisterSchedule(scheduleStore, "smoke-sched", { now: 1100 });

      yield* enqueueJob(queueStore, {
        handler: { name: "direct" },
        input: "hi",
      });
      const claimed = yield* claimRun(queueStore, {
        handlerNames: ["direct"],
        leaseTtlMs: 100,
      });
      if (claimed === undefined) throw new Error("expected claimed direct run");
      const renewed = yield* renewLease(queueStore, claimed.run.id, claimed.lease, {
        leaseTtlMs: 200,
      });
      const expired = yield* recoverExpiredLeases(queueStore, {
        now: (renewed?.expiresAt ?? 0) + 50,
      });
      const reclaimed = yield* claimRun(queueStore, {
        handlerNames: ["direct"],
        leaseTtlMs: 5000,
      });
      if (reclaimed !== undefined) {
        yield* settleRun(
          queueStore,
          reclaimed.run.id,
          reclaimed.lease,
          Exit.succeed({ kind: "complete", output: "done" })
        );
      }

      return {
        decidedCount: evalResult.decided.length,
        defaultClaimTtlMs: DEFAULT_CLAIM_TTL_MS,
        expiredCount: expired.length,
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
    liveness: MARBLES_PORTABLE_OWNER_LIVENESS,
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
    artifactTablesOk,
    authLifecycle,
    commandErrorOk: commandError instanceof CommandError && commandError.result.exitCode === 1,
    committed,
    formattedModel,
    idPrefix: id.startsWith("iso_"),
    libChecks,
    marblesItems: marblesWorkspace.input.definitions?.length ?? 0,
    marblesRunOutput,
    modelsReady: Array.isArray(models.providers),
    modulesCount: listedModules.items.length,
    pageItems: page.items,
    parsedArgvCount: parsedArgv.length,
    pathsMarbles: paths.marbles,
    plainLayerRemoved,
    promptApiType,
    queueResult,
    renderedPrompt,
    sandboxPath,
    sandboxRows: sandboxRows.length,
    sessionId: session.id,
    taskChecks,
    taskId: createdTask.id,
    usageChecks,
    usageReady: usageSnapshot.name === "smoke-account",
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
      artifactTablesOk: true,
      authLifecycle: {
        afterRevoke: "ask",
        beforeRevoke: "allow",
        permitRan: true,
      },
      commandErrorOk: true,
      committed: true,
      formattedModel: "openai/gpt-5",
      idPrefix: true,
      libChecks: {
        abortOk: "ok",
        canonical: '{"a":2,"b":1}',
        d1BatchRows: 20,
        digestLen: 64,
        emitted: 1,
        globMatched: true,
        instAlive: true,
        keyedRan: "ok",
        livenessState: "unknown",
        mime: true,
        ordered: true,
        portableValid: true,
        questionToolMarked: true,
        reentrancyGuarded: false,
        roundTripped: "v8",
        sqliteBytesType: "function",
        turnRan: "ok",
      },
      marblesItems: 2,
      marblesRunOutput: "hi v8",
      modelsReady: true,
      modulesCount: 0,
      pageItems: ["a", "b"],
      parsedArgvCount: 2,
      pathsMarbles: "/virtual/marbles",
      plainLayerRemoved: true,
      promptApiType: "function",
      queueResult: {
        decidedCount: 1,
        defaultClaimTtlMs: 60_000,
        expiredCount: 1,
        soonest: 2000,
      },
      renderedPrompt: "hello isolate",
      sandboxPath: "/workspace/src/index.ts",
      sandboxRows: 0,
      taskChecks: {
        blockedKind: "blocked",
        readyCount: 1,
      },
      usageChecks: {
        billedRemaining: 37.5,
        budgetRemaining: 60,
        noCredentialExposed: true,
        share: 0.75,
        snapshotName: "smoke-account",
      },
      usageReady: true,
      wfOutput: 42,
      workspacesCount: 0,
    });
    expect(typeof result.artifactId).toBe("string");
    expect(typeof result.sessionId).toBe("string");
    expect(typeof result.taskId).toBe("string");
  }, 30_000);
});
