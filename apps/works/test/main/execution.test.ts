import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryArtifactStore } from "@foundry/artifacts";
import type { ModuleVersion } from "@foundry/modules/domain";
import {
  type ExecutionRun,
  InMemoryStateStore,
  JsonStateStore,
} from "@foundry.sh/marbles/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { moduleQueue, SYSTEM_QUEUE } from "~/main/execution/contract";
import { WorksEngineStartError } from "~/main/execution/engine";
import { routeModuleLibrary } from "~/main/execution/library";
import { ModuleBuilds } from "~/main/modules/builds/controller";
import {
  createModuleLibrary,
  createModuleRecords,
  savingLibrary,
} from "~/main/modules/library";
import { ModuleSessions } from "~/main/modules/runtime/controller";
import { WORKS_TASKS } from "~/shared/execution";
import type { SourceSaveEvidence } from "~/shared/observations";
import { startTestExecution } from "../helpers/execution";
import { fakeClient, openFakeVault } from "../helpers/fake-api";
import { successfulBuildRuntime } from "../helpers/module-build";
import { moduleReleasePackage } from "../helpers/module-release";
import {
  openTestLocalLibrary,
  recordedSaves,
  unrecordedSaves,
} from "../helpers/source-saves";
import { DISK_TEST_TIMEOUT_MS } from "../helpers/timeouts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});
async function temporary(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** A pid that has certainly exited, as a crashed Works process leaves behind. */
function deadPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  if (pid === undefined) {
    throw new Error("No pid for the exited process");
  }
  return pid;
}

async function routed(directory?: string) {
  const execution = await startTestExecution(
    directory === undefined ? {} : { directory }
  );
  const store = new InMemoryArtifactStore();
  const core = createModuleLibrary(store, {
    saves: recordedSaves(execution, store),
  });
  const library = routeModuleLibrary(core, execution);
  const module = await library.create("Routed");
  const details = await library.details(module.id);
  if (!details?.binding) {
    throw new Error("Starter binding missing");
  }
  return {
    binding: details.binding,
    core,
    details,
    execution,
    library,
    module,
  };
}

function runsNamed(runs: readonly ExecutionRun[], name: string) {
  return runs.filter((run) => run.name === name);
}

describe("Works execution engine startup", () => {
  it("fails Works startup when the engine cannot recover its run store", async () => {
    const store = new InMemoryStateStore();
    vi.spyOn(store, "list").mockImplementation(() => {
      throw new Error("run store unreadable");
    });
    const started = startTestExecution({ store });
    await expect(started).rejects.toBeInstanceOf(WorksEngineStartError);
    await expect(started).rejects.toThrow(
      "The execution engine could not start: run store unreadable"
    );
  });

  it("fails Works startup when its engine directory cannot be created", async () => {
    const root = await temporary("works-engine-file-");
    const occupied = path.join(root, "engine");
    await writeFile(occupied, "not a directory");
    await expect(
      startTestExecution({ directory: path.join(occupied, "state") })
    ).rejects.toBeInstanceOf(WorksEngineStartError);
  });

  it("refuses routed actions once the engine is gone instead of calling the library directly", async () => {
    const { binding, core, details, execution, library, module } =
      await routed();
    const saveSource = vi.spyOn(core, "saveSource");
    await execution.close();
    await expect(
      library.saveSource(module.id, details.source, binding)
    ).rejects.toThrow();
    expect(saveSource).not.toHaveBeenCalled();
  });

  it("lets work admitted before quit finish and record its outcome", async () => {
    const execution = await startTestExecution();
    const saving = execution.launch(WORKS_TASKS.save, {}, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "committed";
    });
    const { id, result } = await saving;
    await execution.close();
    await expect(result).resolves.toBe("committed");
    expect(execution.runs.get(id)).toMatchObject({ status: "complete" });
  });

  it("keeps its records in a Works-owned directory, without source text", async () => {
    const directory = await temporary("works-engine-");
    const { binding, details, library, module } = await routed(directory);
    const marker = "routed-save-marker-text";
    await library.saveSource(
      module.id,
      { ...details.source, "README.md": marker },
      binding
    );
    const executions = path.join(directory, "state", "executions");
    const records = await readdir(executions);
    expect(records.length).toBeGreaterThanOrEqual(2);
    for (const record of records) {
      expect(
        await readFile(path.join(executions, record), "utf8")
      ).not.toContain(marker);
    }
  });

  it("settles work a crashed process left behind: running is interrupted, queued fails without running", async () => {
    const directory = await temporary("works-engine-crash-");
    const store = new JsonStateStore(path.join(directory, "state"));
    const pid = deadPid();
    const record = (id: string, status: string, name: string) => ({
      correlation: { moduleId: "module-a" },
      id,
      ...(status === "queued" ? { input: { request: `request-${id}` } } : {}),
      kind: "task",
      name,
      observations: [],
      owner: { pid },
      queue: SYSTEM_QUEUE,
      revision: 2,
      sequence: Date.now() + Number(id.slice(-1)),
      status,
      timestamps: {
        queuedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
    store.write(
      "executions",
      "rn-program-1",
      record("rn-program-1", "running", WORKS_TASKS.program)
    );
    store.write(
      "executions",
      "rn-save-2",
      record("rn-save-2", "queued", WORKS_TASKS.save)
    );
    store.write(
      "executions",
      "rn-other-3",
      record("rn-other-3", "queued", "someone.else")
    );
    const execution = await startTestExecution({ directory });
    expect(execution.runs.get("rn-program-1")).toMatchObject({
      error: { code: "interrupted" },
      status: "interrupted",
    });
    // Queued Works work is let in again and settles at once: its body
    // lived in the dead process, so nothing runs and nothing changes.
    await vi.waitFor(() =>
      expect(execution.runs.get("rn-save-2")).toMatchObject({
        error: { code: "AbandonedRequest" },
        status: "failed",
      })
    );
    expect(execution.runs.get("rn-save-2")?.input).toBeUndefined();
    // A name nothing here registers stays queued and visible, and cancellable.
    expect(execution.runs.get("rn-other-3")).toMatchObject({
      status: "queued",
    });
    await execution.cancel("rn-other-3");
    expect(execution.runs.get("rn-other-3")).toMatchObject({
      status: "cancelled",
    });
  });
});

describe("Works actions as system engine runs", () => {
  it("records a committed source save on its run, in order through the lifecycle", async () => {
    const {
      binding: expected,
      details,
      execution,
      library,
      module,
    } = await routed();
    const seen: string[] = [];
    const subscription = execution.runs.subscribe((run) => {
      if (run.name === WORKS_TASKS.save) {
        seen.push(run.status);
      }
    });
    const saved = await library.saveSource(
      module.id,
      { ...details.source, "README.md": "saved" },
      expected
    );
    subscription.unsubscribe();
    const [save] = runsNamed(execution.runs.list(), WORKS_TASKS.save);
    // Each change is a new revision; the save result lands while running.
    expect([...new Set(seen)]).toEqual(["queued", "running", "complete"]);
    expect(save).toMatchObject({
      correlation: { moduleId: module.id },
      kind: "task",
      queue: SYSTEM_QUEUE,
      status: "complete",
    });
    expect(save?.observations).toEqual([
      expect.objectContaining({
        data: {
          ...saved,
          actor: "user",
          kind: "source",
          moduleId: module.id,
        } satisfies SourceSaveEvidence,
        kind: "result",
        status: "complete",
        type: "save",
      }),
    ]);
  });

  it("keeps fence conflicts intact and records no save for a failed attempt", async () => {
    const { binding, details, execution, library, module } = await routed();
    await library.saveSource(
      module.id,
      { ...details.source, "README.md": "first" },
      binding
    );
    const client = fakeClient(await openFakeVault(), library);
    await expect(
      client.modules.saveSource({
        expected: binding,
        id: module.id,
        source: details.source,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const [, failed] = runsNamed(execution.runs.list(), WORKS_TASKS.save);
    expect(failed).toMatchObject({ observations: [], status: "failed" });
  });

  it("dispatches import and create as runs", async () => {
    const { execution, library } = await routed();
    const { encoded } = await moduleReleasePackage();
    const imported = await library.importPackage(encoded);
    const runs = execution.runs.list();
    expect(runsNamed(runs, WORKS_TASKS.create)).toHaveLength(1);
    expect(runsNamed(runs, WORKS_TASKS.import)).toEqual([
      expect.objectContaining({
        observations: [
          expect.objectContaining({
            data: { artifactId: imported.artifactId, moduleId: imported.id },
            type: "import",
          }),
        ],
        status: "complete",
      }),
    ]);
  });

  it("runs a build with its progress and records the release save from its publish", async () => {
    const { binding, execution, library, module } = await routed();
    const builds = new ModuleBuilds({
      execution,
      library,
      runtime: successfulBuildRuntime,
    });
    const events = await Array.fromAsync(
      builds.watch(module.id, "0.1.0", binding)
    );
    expect(events.at(-1)).toMatchObject({ phase: "complete" });
    const runs = execution.runs.list();
    expect(runsNamed(runs, WORKS_TASKS.build)).toEqual([
      expect.objectContaining({
        correlation: { moduleId: module.id },
        progress: { phase: "publishing" },
        status: "complete",
      }),
    ]);
    const [publish] = runsNamed(runs, WORKS_TASKS.publish);
    expect(publish?.observations).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "release",
          moduleId: module.id,
          tag: "0.1.0",
        }),
        type: "save",
      }),
    ]);
    await builds.shutdown();
  });

  it("records a cancelled build as cancelled", async () => {
    const { binding, execution, library, module } = await routed();
    const entered = Promise.withResolvers<void>();
    const builds = new ModuleBuilds({
      execution,
      library,
      runtime: {
        async run({ signal }) {
          entered.resolve();
          await new Promise((resolve) =>
            signal.addEventListener("abort", resolve, { once: true })
          );
          throw signal.reason;
        },
      },
    });
    const watch = builds.watch(module.id, "0.1.0", binding);
    await entered.promise;
    await watch.return();
    expect(runsNamed(execution.runs.list(), WORKS_TASKS.build)).toEqual([
      expect.objectContaining({ status: "cancelled" }),
    ]);
  });

  it("keeps a Program's run running until it is stopped, then complete", async () => {
    const execution = await startTestExecution();
    const library = createModuleLibrary(new InMemoryArtifactStore(), {
      saves: unrecordedSaves,
    });
    const { encoded } = await moduleReleasePackage();
    const imported = await library.importPackage(encoded);
    const release = (await library.details(imported.id))?.releases[0];
    if (!release) {
      throw new Error("Release missing");
    }
    const close = vi.fn(async () => undefined);
    const sessions = new ModuleSessions({
      execution,
      library,
      runtime: {
        revoked: () => undefined,
        shutdown: async () => undefined,
        start: async (_version: ModuleVersion) => ({
          close,
          origin: "http://127.0.0.1:3000",
        }),
      },
    });
    const watch = sessions.watch(imported.id, release.contentId);
    await watch.next();
    const program = () =>
      runsNamed(execution.runs.list(), WORKS_TASKS.program)[0];
    expect(program()).toMatchObject({
      correlation: { contentId: release.contentId, moduleId: imported.id },
      status: "running",
    });
    // Its lifetime holds no slot: later system work starts at once.
    expect(
      execution.runs.queues().find((queue) => queue.name === SYSTEM_QUEUE)
    ).toMatchObject({ active: 0 });
    await watch.return();
    expect(close).toHaveBeenCalledOnce();
    expect(program()).toMatchObject({ status: "complete" });
  });

  it("commits saves to one Module in request order", {
    timeout: DISK_TEST_TIMEOUT_MS,
  }, async () => {
    const root = await temporary("works-fifo-");
    const execution = await startTestExecution();
    const { library: local } = await openTestLocalLibrary(root, { execution });
    const library = routeModuleLibrary(local, execution);
    const module = await library.create("FIFO");
    const details = await library.details(module.id);
    if (!details?.binding) {
      throw new Error("Binding missing");
    }
    const { binding, source } = details;
    // Every request carries the same fence, so only the first one admitted
    // can commit; the rest must conflict.
    const results = await Promise.allSettled(
      [0, 1, 2, 3, 4].map((index) =>
        library.saveSource(
          module.id,
          { ...source, "README.md": `request ${index}` },
          binding
        )
      )
    );
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
      "rejected",
      "rejected",
      "rejected",
    ]);
    expect((await library.details(module.id))?.source["README.md"]).toBe(
      "request 0"
    );
    const saves = runsNamed(execution.runs.list(), WORKS_TASKS.save);
    expect(saves.map((run) => run.status)).toEqual([
      "complete",
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
  });

  it("enters the library in request order however long each save takes", async () => {
    const execution = await startTestExecution();
    const entered: number[] = [];
    const store = new InMemoryArtifactStore();
    const library = savingLibrary(
      {
        ...createModuleRecords(store),
        async writeSource(_id, source) {
          entered.push(Number(source.index));
          await new Promise((resolve) =>
            setTimeout(resolve, Math.random() * 5)
          );
          return {
            artifactId: "artifact",
            contentId: "content",
            updatedAt: new Date().toISOString(),
          };
        },
      },
      recordedSaves(execution, store),
      (_moduleId, commit) => commit()
    );
    const expected = {
      artifactId: "artifact",
      contentId: "content",
      updatedAt: new Date().toISOString(),
    };
    const order = Array.from({ length: 20 }, (_, index) => index);
    await Promise.all(
      order.map((index) =>
        library.saveSource("module-a", { index: String(index) }, expected)
      )
    );
    expect(entered).toEqual(order);
    const sequences = runsNamed(execution.runs.list(), WORKS_TASKS.save).map(
      (run) => run.sequence
    );
    expect(sequences).toEqual(sequences.toSorted((a, b) => a - b));
  });
});

describe("Module queues", () => {
  it("admit Module authoring work one at a time by default, and change live", async () => {
    const execution = await startTestExecution();
    const queue = { kind: "authoring", moduleId: "module-a" } as const;
    const release = Promise.withResolvers<void>();
    const first = await execution.launch(
      "works.authoring.turn",
      { correlation: { moduleId: "module-a" }, queue },
      () => release.promise
    );
    const second = await execution.launch(
      "works.authoring.turn",
      { correlation: { moduleId: "module-a" }, queue },
      () => "second"
    );
    expect(execution.runs.get(second.id)).toMatchObject({ status: "queued" });
    // Another Module's queue is not held up by this backlog.
    await expect(
      execution.dispatch(
        "works.authoring.turn",
        { queue: { kind: "authoring", moduleId: "module-b" } },
        () => "other"
      )
    ).resolves.toBe("other");
    execution.configureModuleQueues("module-a", { authoring: 2 });
    await expect(second.result).resolves.toBe("second");
    release.resolve();
    await first.result;
    expect(
      execution.runs
        .queues()
        .find((state) => state.name === moduleQueue("module-a", "authoring"))
    ).toMatchObject({ concurrency: 2 });
  });

  it("does not let a long system run hold up a save", async () => {
    const { binding, details, execution, library, module } = await routed();
    const hold = Promise.withResolvers<void>();
    const long = await execution.launch(
      WORKS_TASKS.build,
      { correlation: { moduleId: module.id } },
      () => hold.promise
    );
    await library.saveSource(module.id, details.source, binding);
    expect(execution.runs.get(long.id)).toMatchObject({ status: "running" });
    hold.resolve();
    await long.result;
  });
});
