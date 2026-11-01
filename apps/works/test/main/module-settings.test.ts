import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryArtifactStore } from "@foundry/artifacts";
import { ModuleSettingsError } from "@foundry/modules/settings";
import { afterEach, describe, expect, it } from "vitest";
import { moduleQueue } from "~/main/execution/contract";
import { routeModuleLibrary } from "~/main/execution/library";
import { createModuleLibrary } from "~/main/modules/library";
import { moduleDirectory } from "~/main/modules/local-library";
import { ModuleSettings } from "~/main/modules/settings";
import { WORKS_TASKS } from "~/shared/execution";
import { startTestExecution } from "../helpers/execution";
import { fakeClient, openFakeVault } from "../helpers/fake-api";
import { unrecordedSaves } from "../helpers/source-saves";

const GIB = 1024 * 1024 * 1024;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

/** A strict Manifest for the starter: same Program, Views and data. */
function strictManifest(legacyText: string, change: object = {}) {
  const legacy = JSON.parse(legacyText) as Record<string, unknown>;
  return JSON.stringify({
    ...legacy,
    format: "foundry.module-manifest/1",
    persistence: { files: "installation" },
    ...change,
  });
}

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "works-settings-"));
  directories.push(directory);
  const execution = await startTestExecution();
  const library = routeModuleLibrary(
    createModuleLibrary(new InMemoryArtifactStore(), {
      saves: unrecordedSaves,
    }),
    execution
  );
  const module = await library.create("Settings");
  const settings = () =>
    new ModuleSettings({
      directory: path.join(directory, "module-settings"),
      execution,
      library,
    });
  async function declare(change: object) {
    const details = await library.details(module.id);
    if (!details?.binding) {
      throw new Error("Starter binding missing");
    }
    const { "foundry.module.json": legacyText = "{}" } = details.source;
    await library.saveSource(
      module.id,
      {
        ...details.source,
        "foundry.module.json": strictManifest(legacyText, change),
      },
      details.binding
    );
  }
  return { declare, directory, execution, library, module, settings };
}

describe("Module settings in Works state", () => {
  it("reports host defaults and ceilings for a Module that declares nothing", async () => {
    const { module, settings } = await setup();

    const view = await settings().get(module.id);

    expect(view).toMatchObject({
      effective: {
        "authoring.maxSteps": 20,
        "queues.authoring.concurrency": 1,
        "resources.memoryBytes": 2 * GIB,
        "sandbox.idlePolicy": "keep-on",
      },
      moduleId: module.id,
      problems: [],
      user: {},
    });
    expect(view.keys).toContainEqual({
      ceiling: 4,
      default: 1,
      integer: true,
      key: "queues.workflows.concurrency",
      unit: "runs",
    });
  });

  it("stores user values as a system run and applies queue concurrency", async () => {
    const { directory, execution, module, settings } = await setup();

    const view = await settings().set(module.id, {
      "authoring.maxSteps": 12,
      "queues.workflows.concurrency": 3,
    });

    expect(view.effective).toMatchObject({
      "authoring.maxSteps": 12,
      "queues.workflows.concurrency": 3,
    });
    const run = execution.runs
      .list()
      .find((candidate) => candidate.name === WORKS_TASKS.settings);
    expect(run).toMatchObject({
      correlation: { moduleId: module.id },
      queue: "system",
      status: "complete",
    });
    expect(run?.observations).toMatchObject([
      {
        data: {
          moduleId: module.id,
          values: {
            "authoring.maxSteps": 12,
            "queues.workflows.concurrency": 3,
          },
        },
        kind: "result",
        type: "settings",
      },
    ]);
    expect(
      execution.runs
        .queues()
        .find((queue) => queue.name === moduleQueue(module.id, "workflows"))
    ).toMatchObject({ concurrency: 3 });
    expect(
      JSON.parse(
        await readFile(
          path.join(
            directory,
            "module-settings",
            `${moduleDirectory(module.id)}.json`
          ),
          "utf8"
        )
      )
    ).toEqual({
      format: "works.module-settings/1",
      values: { "authoring.maxSteps": 12, "queues.workflows.concurrency": 3 },
    });

    // Another process reads the same values back and reapplies them.
    const restarted = settings();
    expect(await restarted.user(module.id)).toEqual({
      "authoring.maxSteps": 12,
      "queues.workflows.concurrency": 3,
    });
    await expect(restarted.authoringLimits(module.id)).resolves.toMatchObject({
      deadlineMs: 600_000,
      maxSteps: 12,
    });
  });

  it("reads effective settings without touching queues; applying them is explicit", async () => {
    const { execution, module, settings } = await setup();
    await settings().set(module.id, { "queues.workflows.concurrency": 3 });
    // As a restarted process finds them: the engine's defaults.
    execution.configureModuleQueues(module.id, { workflows: 1 });
    const workflowsQueue = () =>
      execution.runs
        .queues()
        .find((queue) => queue.name === moduleQueue(module.id, "workflows"));
    const service = settings();

    await expect(service.effective(module.id)).resolves.toMatchObject({
      "queues.workflows.concurrency": 3,
    });
    await service.artifactLimits(module.id);
    await service.authoringLimits(module.id);
    await service.auditRetention(module.id);
    await service.sandboxResources(module.id);
    expect(workflowsQueue()).toMatchObject({ concurrency: 1 });

    await service.applyQueues(module.id);
    expect(workflowsQueue()).toMatchObject({ concurrency: 3 });
  });

  it.each([
    [{ network: 1 }, "network is authority, not a setting"],
    [{ "host.operations": 1 }, "host.operations is authority, not a setting"],
    [{ "sandbox.idlePolicy": 1 }, "sandbox.idlePolicy is fixed"],
    [
      { "queues.authoring.concurrency": 2 },
      "queues.authoring.concurrency is set to 2 runs; this host allows at most 1",
    ],
    [{ "resources.memoryBytes": 4 * GIB }, "this host allows at most"],
  ])("refuses %j without storing it", async (values, message) => {
    const { execution, module, settings } = await setup();
    const service = settings();

    await expect(service.set(module.id, values)).rejects.toThrow(message);

    expect(await service.user(module.id)).toEqual({});
    expect(
      execution.runs
        .list()
        .find((candidate) => candidate.name === WORKS_TASKS.settings)
    ).toMatchObject({ status: "failed" });
  });

  it("resolves the saved Manifest's requests, minimums and defaults", async () => {
    const { declare, module, settings } = await setup();
    await declare({
      resources: { cpus: 2, memoryBytes: GIB },
      settings: {
        "authoring.maxSteps": { default: 8 },
        "authoring.source.maxFiles": { default: 500 },
      },
    });
    const service = settings();

    await expect(service.authoringLimits(module.id)).resolves.toMatchObject({
      maxSteps: 8,
      source: { maxFiles: 500 },
    });
    await expect(service.sandboxResources(module.id)).resolves.toEqual({
      cpus: 2,
      memoryBytes: 2 * GIB,
    });
    await expect(
      service.set(module.id, { "resources.cpus": 1 })
    ).rejects.toThrow(
      "resources.cpus is set to 1 CPUs; the Module requires at least 2"
    );
  });

  it("keeps effective settings until the user's values or the Manifest change", async () => {
    const { declare, directory, execution, library, module } = await setup();
    let manifestReads = 0;
    const service = new ModuleSettings({
      directory: path.join(directory, "module-settings"),
      execution,
      library: {
        manifest: (moduleId) => {
          manifestReads += 1;
          return library.manifest(moduleId);
        },
      },
    });
    await service.artifactLimits(module.id);
    await service.authoringLimits(module.id);
    await service.auditRetention(module.id);
    expect(manifestReads).toBe(1);

    await service.set(module.id, { "authoring.maxSteps": 6 });
    await expect(service.authoringLimits(module.id)).resolves.toMatchObject({
      maxSteps: 6,
    });

    // A Manifest change reaches the kept settings once Works says so.
    await declare({ settings: { "authoring.maxSteps": { minimum: 9 } } });
    await expect(service.authoringLimits(module.id)).resolves.toMatchObject({
      maxSteps: 6,
    });
    await expect(service.applyQueues(module.id)).rejects.toThrow(
      ModuleSettingsError
    );
    await expect(service.authoringLimits(module.id)).rejects.toThrow(
      ModuleSettingsError
    );
  });

  it("reports and refuses a requirement the host cannot meet", async () => {
    const { declare, module, settings } = await setup();
    await declare({ resources: { memoryBytes: 8 * GIB } });
    const service = settings();

    const view = await service.get(module.id);
    expect(view.effective).toBeNull();
    expect(view.problems).toEqual([
      {
        key: "resources.memoryBytes",
        message: `The Module requires resources.memoryBytes of at least ${8 * GIB} bytes; this host allows at most ${2 * GIB}`,
      },
    ]);
    await expect(service.sandboxResources(module.id)).rejects.toThrow(
      ModuleSettingsError
    );
    await expect(service.authoringLimits(module.id)).rejects.toThrow(
      ModuleSettingsError
    );
  });

  it("serves get and set over RPC, reporting refusals as bad requests", async () => {
    const { library, module, settings } = await setup();
    const client = fakeClient(await openFakeVault(), library, {
      moduleSettings: settings(),
    });

    await expect(
      client.moduleSettings.set({
        id: module.id,
        values: { "explorer.pageSize": 50 },
      })
    ).resolves.toMatchObject({ user: { "explorer.pageSize": 50 } });
    await expect(
      client.moduleSettings.get({ id: module.id })
    ).resolves.toMatchObject({ effective: { "explorer.pageSize": 50 } });
    await expect(
      client.moduleSettings.set({ id: module.id, values: { network: 1 } })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      fakeClient(await openFakeVault(), library).moduleSettings.get({
        id: module.id,
      })
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
});
