import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonArtifactStore } from "@foundry/artifacts/node";
import type { ModuleVersion } from "@foundry/modules/domain";
import type { ModuleRuntimeIdentity } from "@foundry/modules/gateway/types";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import {
  EXECUTION_CAPABILITIES,
  executionCapabilities,
} from "~/main/execution/capabilities";
import { moduleQueue } from "~/main/execution/contract";
import type { WorksEngineOptions } from "~/main/execution/engine";
import {
  ModuleWorkflows,
  type WorkflowExecutionEvent,
  type WorkflowStarted,
} from "~/main/execution/module-workflows";
import type { WorkflowModels } from "~/main/execution/workflows";
import { modulePersistence } from "~/main/modules/artifact-store";
import { vaultAuthoringModels } from "~/main/modules/authoring/models";
import { moduleInstallationId } from "~/main/modules/runtime/installation";
import { credentialedScriptedModels } from "../helpers/authoring-model";
import { startTestExecution } from "../helpers/execution";
import { installedProcess } from "../helpers/installed-programs";
import { DISK_TEST_TIMEOUT_MS } from "../helpers/timeouts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const TICKER = "works.examples.ticker@1";
const SUMMARIZE = "works.text.summarize@1";
const ALL = Object.values(EXECUTION_CAPABILITIES);

function workflowManifest(workflows: readonly string[] = [TICKER, SUMMARIZE]) {
  return {
    capabilities: [
      {
        alias: "start",
        capability: EXECUTION_CAPABILITIES.start,
        constraints: { workflows },
      },
      { alias: "runs", capability: EXECUTION_CAPABILITIES.watch },
      { alias: "cancel", capability: EXECUTION_CAPABILITIES.cancel },
    ].map((request) => ({
      ...request,
      reason: "Runs host workflows",
      version: 1,
    })),
    views: { main: { path: "/", title: "Workflows" } },
  };
}

const noModels: WorkflowModels = {
  route: () => {
    throw new Error("no models in this test");
  },
};

interface Target {
  runtime: ModuleRuntimeIdentity;
  version: ModuleVersion;
}

const DIGEST = /^[0-9a-f]{64}$/;

async function setup(
  options: { engine?: WorksEngineOptions; models?: WorkflowModels } = {}
) {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "works-workflows-"))
  );
  cleanups.push(() => rm(directory, { force: true, recursive: true }));
  const execution = await startTestExecution(options.engine);
  const store = new JsonArtifactStore({
    path: path.join(directory, "artifacts.json"),
  });
  const workflows = new ModuleWorkflows({
    execution,
    models: options.models ?? noModels,
  });
  onTestFinished(() => workflows.shutdown());
  // Revoking the start Grant cancels the Installation's executions (its
  // capability's hook); a stopped Program's executions end with it.
  const works = installedProcess(
    store,
    execution,
    directory,
    executionCapabilities({
      modules: modulePersistence(store).modules,
      workflows,
    }),
    {
      stopped: (installationId) => workflows.cancelInstallation(installationId),
    }
  );
  const { access } = works;
  let requests = 0;

  async function app(
    name = "Workflows",
    grants: readonly string[] = ALL,
    manifest: object = workflowManifest()
  ) {
    const module = await works.library.create(name);
    const version = await works.release(module.id, "1.0.0", manifest);
    for (const capability of grants) {
      await access.approve(module.id, capability);
    }
    return { module, version, ...(await start(version)) };
  }

  async function start(version: ModuleVersion) {
    const controller = new AbortController();
    const opened = await works.runtime.start(version, controller.signal);
    const runtime = await works.programs.active(
      moduleInstallationId(version.moduleId)
    );
    if (!runtime) {
      throw new Error("Program not active");
    }
    return { opened, runtime };
  }

  function call<T>(target: Target, alias: string, input: unknown): Promise<T> {
    requests += 1;
    return works.invocations
      .dispatch({
        capabilities: target.version.manifest.capabilities,
        request: {
          alias,
          id: String(requests),
          input,
          kind: "invoke",
          mode: "unary",
        },
        runtime: target.runtime,
        signal: new AbortController().signal,
      })
      .then((result) => {
        if (result.mode !== "unary") {
          throw new Error("expected unary");
        }
        return result.output as T;
      });
  }

  async function watch(
    target: Target,
    id: string,
    signal = new AbortController().signal
  ): Promise<AsyncIterator<WorkflowExecutionEvent>> {
    requests += 1;
    const result = await works.invocations.dispatch({
      capabilities: target.version.manifest.capabilities,
      request: {
        alias: "runs",
        id: String(requests),
        input: { execution: id },
        kind: "invoke",
        mode: "stream",
      },
      runtime: target.runtime,
      signal,
    });
    if (result.mode !== "stream") {
      throw new Error("expected stream");
    }
    return (result.events as AsyncIterable<WorkflowExecutionEvent>)[
      Symbol.asyncIterator
    ]();
  }

  /** Every event until the stream ends. */
  async function drain(events: AsyncIterator<WorkflowExecutionEvent>) {
    const seen: WorkflowExecutionEvent[] = [];
    for (;;) {
      const next = await events.next();
      if (next.done) {
        return seen;
      }
      seen.push(next.value);
    }
  }

  const ticker = (
    target: Target,
    request: string,
    input = { count: 3, intervalMs: 5 }
  ) =>
    call<WorkflowStarted>(target, "start", {
      input,
      request,
      version: 1,
      workflow: "works.examples.ticker",
    });

  return {
    access,
    app,
    call,
    directory,
    drain,
    execution,
    start,
    ticker,
    watch,
    works,
  };
}

const unavailable = {
  code: "unauthorized",
  message: "This execution is not available",
};

describe("Module execution providers", () => {
  it("starts an allowed workflow on the Module's workflows queue, watches it to completion and answers retries", async () => {
    const { app, drain, execution, ticker, watch } = await setup();
    const target = await app();
    const started = await ticker(target, "first");
    expect(started).toMatchObject({ retried: false });

    // Recorded as an engine run before it did anything: correlated, with
    // the request's identity and an input digest, but not the input.
    const run = execution.runs.get(started.execution);
    expect(run).toMatchObject({
      correlation: {
        installationId: target.runtime.installationId,
        moduleId: target.module.id,
        request: "first",
        runtimeInstanceId: target.runtime.runtimeInstanceId,
        workflow: TICKER,
      },
      kind: "task",
      name: TICKER,
      queue: moduleQueue(target.module.id, "workflows"),
    });
    expect(run?.correlation.input).toMatch(DIGEST);
    expect(JSON.stringify(run)).not.toContain("intervalMs");

    const events = await drain(await watch(target, started.execution));
    expect(events[0]?.kind).toBe("snapshot");
    expect(events.at(-1)).toMatchObject({
      error: null,
      kind: "update",
      output: { ticks: 3 },
      progress: { count: 3, tick: 3 },
      status: "complete",
      workflow: TICKER,
    });
    const revisions = events.map((event) => event.revision);
    expect(revisions).toEqual([...new Set(revisions)].sort((a, b) => a - b));

    // A reconnect is a fresh snapshot, here of the finished run.
    expect(await drain(await watch(target, started.execution))).toEqual([
      { ...events.at(-1), kind: "snapshot" },
    ]);

    // Resending the request answers it; reusing it for other input is refused.
    expect(await ticker(target, "first")).toEqual({
      execution: started.execution,
      retried: true,
      status: "complete",
    });
    await expect(
      ticker(target, "first", { count: 4, intervalMs: 5 })
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(
      execution.runs.list().filter((candidate) => candidate.name === TICKER)
    ).toHaveLength(1);
  });

  it("refuses workflows outside its Grant, unknown workflows and invalid input", {
    timeout: DISK_TEST_TIMEOUT_MS,
  }, async () => {
    const { access, app, call, ticker } = await setup();
    const target = await app("Ticker only", ALL, workflowManifest([TICKER]));
    await expect(
      call(target, "start", {
        input: { text: "hello" },
        request: "s",
        version: 1,
        workflow: "works.text.summarize",
      })
    ).rejects.toMatchObject({
      code: "unauthorized",
      message: `Starting ${SUMMARIZE} is not approved`,
    });
    await expect(
      ticker(target, "bad", { count: 0, intervalMs: 5 })
    ).rejects.toMatchObject({ code: "invalid-input" });

    // A Manifest naming an unregistered workflow cannot be approved.
    const unknown = await app(
      "Unknown",
      [],
      workflowManifest(["works.nothing@1"])
    );
    const view = await access.get(unknown.module.id);
    expect(
      view.requests.find(
        (request) => request.capability === EXECUTION_CAPABILITIES.start
      )
    ).toMatchObject({ approved: false, availability: "denied" });
    await expect(
      access.approve(unknown.module.id, EXECUTION_CAPABILITIES.start)
    ).rejects.toThrow("cannot be approved");
  });

  it("denies every operation without its Grant", async () => {
    const { app, call, ticker, watch } = await setup();
    const none = await app("No grants", []);
    await expect(ticker(none, "x")).rejects.toMatchObject({
      code: "unauthorized",
    });
    const startOnly = await app("Start only", [EXECUTION_CAPABILITIES.start]);
    const started = await ticker(startOnly, "y");
    await expect(watch(startOnly, started.execution)).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(
      call(startOnly, "cancel", { execution: started.execution })
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("cancels through the engine, and refuses another runtime's executions even with their ids", async () => {
    const { app, call, drain, execution, start, ticker, watch } = await setup();
    const target = await app();
    const started = await ticker(target, "long", {
      count: 50,
      intervalMs: 1000,
    });
    const events = await watch(target, started.execution);
    expect((await events.next()).value).toMatchObject({ kind: "snapshot" });

    // Another Module's runtime, a guessed id, and a host run all fail alike.
    const other = await app("Other");
    const foreign = [
      started.execution,
      "rn-00000000-0000-0000-0000-000000000000",
      execution.runs
        .list()
        .find((run) => run.correlation.workflow === undefined)?.id ?? "",
    ];
    for (const id of foreign) {
      const refused = await watch(other, id);
      await expect(refused.next()).rejects.toMatchObject(unavailable);
      await expect(
        call(other, "cancel", { execution: id })
      ).rejects.toMatchObject(unavailable);
    }

    expect(
      await call(target, "cancel", { execution: started.execution })
    ).toEqual({ status: "cancelled" });
    expect((await drain(events)).at(-1)).toMatchObject({
      output: null,
      status: "cancelled",
    });
    expect(execution.runs.get(started.execution)?.status).toBe("cancelled");
    // A finished execution keeps its outcome.
    expect(
      await call(target, "cancel", { execution: started.execution })
    ).toEqual({ status: "cancelled" });

    // The next runtime of the same Module does not inherit the old one's ids.
    const running = await ticker(target, "while-open", {
      count: 50,
      intervalMs: 1000,
    });
    await target.opened.close();
    await expect
      .poll(() => execution.runs.get(running.execution)?.status)
      .toBe("cancelled");
    const reopened = {
      ...(await start(target.version)),
      version: target.version,
    };
    expect(reopened.runtime.runtimeInstanceId).not.toBe(
      target.runtime.runtimeInstanceId
    );
    const stale = await watch(reopened, started.execution);
    await expect(stale.next()).rejects.toMatchObject(unavailable);
    await expect(ticker(reopened, "long")).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("waits its turn on the Module's workflows queue, at the Module's concurrency", async () => {
    const { app, call, execution, ticker } = await setup();
    const target = await app();
    const first = await ticker(target, "a", { count: 50, intervalMs: 1000 });
    const second = await ticker(target, "b");
    expect(first.status).toBe("running");
    expect(second.status).toBe("queued");
    expect(
      execution.runs
        .queues()
        .find(
          (queue) => queue.name === moduleQueue(target.module.id, "workflows")
        )
    ).toMatchObject({ active: 1, concurrency: 1, waiting: 1 });
    await call(target, "cancel", { execution: first.execution });
    await expect
      .poll(() => execution.runs.get(second.execution)?.status)
      .toBe("complete");
  });

  it("cancels active executions and refuses new starts once the start Grant is revoked; revoking watch ends streams", async () => {
    const { access, app, drain, execution, ticker, watch } = await setup();
    const target = await app();
    const started = await ticker(target, "long", {
      count: 50,
      intervalMs: 1000,
    });
    const queued = await ticker(target, "queued");
    const events = await watch(target, started.execution);
    await events.next();

    await access.revoke(target.module.id, EXECUTION_CAPABILITIES.start);
    expect(execution.runs.get(started.execution)?.status).toBe("cancelled");
    expect(execution.runs.get(queued.execution)?.status).toBe("cancelled");
    expect((await drain(events)).at(-1)).toMatchObject({ status: "cancelled" });
    await expect(ticker(target, "after")).rejects.toMatchObject({
      code: "unauthorized",
    });

    await access.approve(target.module.id, EXECUTION_CAPABILITIES.start);
    const again = await ticker(target, "again", {
      count: 50,
      intervalMs: 1000,
    });
    const live = await watch(target, again.execution);
    await live.next();
    const ended = expect(live.next()).rejects.toMatchObject({
      code: "cancelled",
    });
    await access.revoke(target.module.id, EXECUTION_CAPABILITIES.watch);
    await ended;
    await expect(watch(target, again.execution)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("calls the model on the host: keys never reach run records, observations or the Module", async () => {
    const secret = "sk-works-secret-0123456789";
    const scripted = credentialedScriptedModels([{ text: "A short summary." }]);
    const vault = {
      resolve: (provider: string, key: string) =>
        provider === "gateway" && key === "apiKey" ? secret : undefined,
    };
    const engineDirectory = await realpath(
      await mkdtemp(path.join(tmpdir(), "works-workflow-engine-"))
    );
    cleanups.push(() => rm(engineDirectory, { force: true, recursive: true }));
    const { app, call, drain, execution, watch } = await setup({
      engine: { directory: engineDirectory, models: scripted.models },
      models: vaultAuthoringModels(scripted.models, vault as never),
    });
    const target = await app();
    const text = "Works keeps provider keys in the host process.";
    const started = await call<WorkflowStarted>(target, "start", {
      input: { text },
      request: "summary",
      version: 1,
      workflow: "works.text.summarize",
    });
    const events = await drain(await watch(target, started.execution));
    expect(events.at(-1)).toMatchObject({
      output: { summary: "A short summary." },
      status: "complete",
    });
    // The key was used, on the host only.
    expect(scripted.keys).toContain(secret);
    expect(JSON.stringify(scripted.prompts)).toContain(text);
    expect(JSON.stringify(scripted.prompts)).not.toContain(secret);

    const run = execution.runs.get(started.execution);
    expect(run?.observations).toContainEqual(
      expect.objectContaining({ kind: "model-turn", status: "complete" })
    );
    expect(JSON.stringify(run)).not.toContain(secret);
    expect(JSON.stringify(run)).not.toContain(text);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(started)).not.toContain(secret);
    // Nothing the engine wrote down holds it either.
    const files = await readdir(engineDirectory, {
      recursive: true,
      withFileTypes: true,
    });
    for (const file of files.filter((entry) => entry.isFile())) {
      const contents = await readFile(
        path.join(file.parentPath, file.name),
        "utf8"
      );
      expect(contents).not.toContain(secret);
    }
  });

  it("fails a model workflow without leaking the provider's message when no key is set", async () => {
    const scripted = credentialedScriptedModels([]);
    const { app, call, drain, watch } = await setup({
      models: vaultAuthoringModels(scripted.models, {
        resolve: () => undefined,
      } as never),
    });
    const target = await app();
    const started = await call<WorkflowStarted>(target, "start", {
      input: { text: "anything" },
      request: "nokey",
      version: 1,
      workflow: "works.text.summarize",
    });
    expect(
      (await drain(await watch(target, started.execution))).at(-1)
    ).toMatchObject({
      error: {
        message:
          "No model is set up. Add a Gateway or Vercel API key in Settings.",
      },
      status: "failed",
    });
  });
});
