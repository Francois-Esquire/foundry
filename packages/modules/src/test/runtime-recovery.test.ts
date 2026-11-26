import { describe, expect, it, vi } from "vitest";
import { installationIdSchema, MAX_START_ATTEMPTS } from "../domain";
import { ensureInstallation } from "../management";
import { validateModuleActivation } from "../platform/activation";
import { createModuleRuntimeRecovery } from "../platform/runtime-recovery";
import {
  installationFixture,
  installationId,
  launch,
  settings,
} from "./helpers/installation-fixture";
import {
  publishedModule,
  WEATHER,
  weatherProvider,
} from "./helpers/published-module";

describe("Interrupted occurrences' retained containers", () => {
  async function interruptedWithContainer(
    status: "starting" | "stopping",
    stopContainer: () => Promise<void> = () => Promise.resolve()
  ) {
    const order: string[] = [];
    const files = {
      backup: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      discardBackup: () => Promise.resolve(),
      prepare: () => Promise.reject(new Error("not started here")),
      release: vi.fn(() => {
        order.push("release files");
        return Promise.resolve();
      }),
      restoreBackup: () => Promise.resolve(false),
    };
    const module = await publishedModule({
      files,
      stopRetainedContainer: async (containerId) => {
        order.push(`stop ${containerId}`);
        await stopContainer();
      },
    });
    const v1 = await module.publish("1.0.0");
    const installation = await ensureInstallation({
      installationId,
      now: new Date(0),
      store: module.store,
      version: v1,
    });
    const begun = await module.store.beginInstallationTransition({
      expectedGeneration: installation.generation,
      installationId,
      now: new Date(1),
      status,
    });
    await module.store.setInstallationContainerId({
      containerId: "container-1",
      expectedGeneration: begun.generation,
      installationId,
      now: new Date(1),
    });
    const recovery = createModuleRuntimeRecovery({
      store: module.store,
      supervisor: module.programs,
    });
    const row = async () =>
      (await module.store.loadGatewayContext(installationId))?.installation;
    return { files, order, recovery, row, store: module.store, v1 };
  }

  it("stops a left-starting occurrence's container before releasing its files", async () => {
    const { order, recovery, row } = await interruptedWithContainer("starting");
    await recovery.stopInterrupted("Host restarted");
    expect(order).toEqual(["stop container-1", "release files"]);
    expect(await row()).toMatchObject({ status: "disabled" });
  });

  it("completes an interrupted stop through its container, not only its record", async () => {
    const { order, recovery, row } = await interruptedWithContainer("stopping");
    await recovery.normalizeInterrupted();
    expect(order).toEqual(["stop container-1", "release files"]);
    expect(await row()).toMatchObject({ status: "disabled" });
  });

  it("fences every interrupted occurrence even when an interrupted stop fails", async () => {
    const { files, recovery, row, store, v1 } = await interruptedWithContainer(
      "stopping",
      () => Promise.reject(new Error("container still running"))
    );
    const laterId = installationIdSchema.parse("later-installation");
    const later = await ensureInstallation({
      installationId: laterId,
      now: new Date(0),
      store,
      version: v1,
    });
    const left = await store.beginInstallationTransition({
      expectedGeneration: later.generation,
      installationId: laterId,
      now: new Date(1),
      status: "starting",
    });
    await store.settleInstallationStatus({
      expectedGeneration: left.generation,
      installationId: laterId,
      now: new Date(1),
      status: "active",
    });

    await expect(recovery.normalizeInterrupted()).rejects.toThrow("Could not");
    expect(files.release).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ status: "failed" });
    expect(
      (await store.loadGatewayContext(laterId))?.installation
    ).toMatchObject({ generation: left.generation + 1, status: "starting" });
  });

  it("keeps the files and settles failed when the container cannot be stopped", async () => {
    const { files, recovery, row } = await interruptedWithContainer(
      "starting",
      () => Promise.reject(new Error("container still running"))
    );
    await expect(recovery.stopInterrupted("Host restarted")).rejects.toThrow(
      "Could not"
    );
    expect(files.release).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ status: "failed" });
  });

  const noLaunch = () => Promise.reject(new Error("no launch"));

  it("stops the container before spending the attempt of a launch that cannot be resolved", async () => {
    const { order, recovery, row } = await interruptedWithContainer("starting");
    await recovery.normalizeInterrupted();
    expect(await recovery.recoverEnabled({ launch: noLaunch })).toEqual([
      { error: new Error("no launch"), installationId, kind: "failed" },
    ]);
    expect(order).toEqual(["stop container-1", "release files"]);
    expect(await row()).toMatchObject({ startAttempts: 1, status: "failed" });
  });

  it("keeps the files and spends the attempt once when that stop fails, then shutdown retries the stop", async () => {
    let stops = 0;
    const { files, order, recovery, row } = await interruptedWithContainer(
      "starting",
      () => {
        stops += 1;
        return stops === 1
          ? Promise.reject(new Error("container still running"))
          : Promise.resolve();
      }
    );
    await recovery.normalizeInterrupted();
    const [result] = await recovery.recoverEnabled({ launch: noLaunch });
    expect(result).toMatchObject({ installationId, kind: "failed" });
    const error = result?.kind === "failed" ? result.error : undefined;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({
      errors: [{ message: "no launch" }, { code: "teardown-failed" }],
      message: `no launch; Installation ${installationId} cleanup is incomplete`,
    });
    expect(files.release).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ startAttempts: 1, status: "failed" });

    await recovery.releaseAll("Host closing");
    expect(order).toEqual([
      "stop container-1",
      "stop container-1",
      "release files",
    ]);
    expect(await row()).toMatchObject({ startAttempts: 1, status: "failed" });
  });

  it("stops an exhausted occurrence's container before settling it failed", async () => {
    const { order, recovery, row, store } =
      await interruptedWithContainer("starting");
    for (let spent = 0; spent < MAX_START_ATTEMPTS; spent += 1) {
      const current = await row();
      const failedAttempt = await store.settleInstallationStatus({
        expectedGeneration: current?.generation ?? 0,
        installationId,
        now: new Date(2),
        status: "failed",
      });
      await store.beginInstallationTransition({
        expectedGeneration: failedAttempt.generation,
        installationId,
        now: new Date(2),
        status: "starting",
      });
    }
    await recovery.normalizeInterrupted();
    const resolve = vi.fn(noLaunch);
    expect(await recovery.recoverEnabled({ launch: resolve })).toMatchObject([
      { error: { message: expect.stringContaining("exhausted") } },
    ]);
    expect(resolve).not.toHaveBeenCalled();
    expect(order).toEqual(["stop container-1", "release files"]);
    expect(await row()).toMatchObject({ status: "failed" });
  });

  it("leaves the container to whoever moved the row, or to the next boot after an abort", async () => {
    const { order, recovery, row, store } =
      await interruptedWithContainer("starting");
    await recovery.normalizeInterrupted();
    const campaign = new AbortController();
    await expect(
      recovery.recoverEnabled({
        launch: () => {
          campaign.abort(new Error("Host is shutting down"));
          return noLaunch();
        },
        signal: campaign.signal,
      })
    ).rejects.toThrow("Host is shutting down");
    expect(await row()).toMatchObject({ startAttempts: 0, status: "starting" });

    await recovery.recoverEnabled({
      launch: async (installation) => {
        await store.beginInstallationTransition({
          expectedGeneration: installation.generation,
          installationId,
          now: new Date(2),
          status: "stopping",
        });
        return noLaunch();
      },
    });
    expect(await row()).toMatchObject({ startAttempts: 0, status: "stopping" });
    expect(order).toEqual([]);
  });
});

describe("Module boot recovery attempts", () => {
  async function interrupted() {
    const fixed = await installationFixture();
    await fixed.store.beginInstallationTransition({
      expectedGeneration: fixed.installation.generation,
      installationId,
      now: new Date(1),
      status: "starting",
    });
    const recovery = createModuleRuntimeRecovery({
      store: fixed.store,
      supervisor: fixed.programs,
    });
    await recovery.normalizeInterrupted();
    const row = async () =>
      (await fixed.store.loadGatewayContext(installationId))?.installation;
    return { ...fixed, recovery, row };
  }

  it("lets a host validate recovery through the same activation policy before any acquisition", async () => {
    const { recovery, row, store, start, v1 } = await interrupted();
    const results = await recovery.recoverEnabled({
      async launch(installation) {
        await validateModuleActivation(
          { installation, launch, settings, version: v1 },
          { providers: [weatherProvider], store }
        );
        return launch;
      },
    });
    expect(results).toMatchObject([
      { error: { name: "ModuleActivationRefusedError" }, kind: "failed" },
    ]);
    expect(start).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ startAttempts: 1, status: "failed" });
  });

  it("restarts through the raw supervisor only after the host supplies an approved launch", async () => {
    const { recovery, row, store, start, v1, access } = await interrupted();
    const installation = await row();
    if (!installation) {
      throw new Error("expected interrupted installation");
    }
    await access.approve({ capability: WEATHER, installation, version: v1 });
    const results = await recovery.recoverEnabled({
      async launch(current) {
        await validateModuleActivation(
          { installation: current, launch, settings, version: v1 },
          { providers: [weatherProvider], store }
        );
        return launch;
      },
    });
    expect(results).toEqual([{ installationId, kind: "started" }]);
    expect(start).toHaveBeenCalledOnce();
    expect(await row()).toMatchObject({ startAttempts: 0, status: "active" });
  });

  it("spends one attempt and settles failed when the launch cannot be resolved, so the next boot does not retry it", async () => {
    const { recovery, row, start } = await interrupted();
    const resolve = vi.fn(() => Promise.reject(new Error("no launch")));

    expect(await recovery.recoverEnabled({ launch: resolve })).toEqual([
      { error: new Error("no launch"), installationId, kind: "failed" },
    ]);
    expect(start).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ startAttempts: 1, status: "failed" });

    await recovery.normalizeInterrupted();
    expect(await recovery.recoverEnabled({ launch: resolve })).toEqual([]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(await row()).toMatchObject({ startAttempts: 1, status: "failed" });
  });

  it("leaves the row starting, attempts unspent, when the campaign is aborted during launch", async () => {
    const { recovery, row } = await interrupted();
    const before = await row();
    const campaign = new AbortController();
    await expect(
      recovery.recoverEnabled({
        launch: () => {
          campaign.abort(new Error("Host is shutting down"));
          return Promise.reject(new Error("aborted"));
        },
        signal: campaign.signal,
      })
    ).rejects.toThrow("Host is shutting down");
    expect(await row()).toEqual(before);
  });

  it("leaves a row that moved on during launch to whoever moved it", async () => {
    const { recovery, row, store } = await interrupted();
    let moved: Awaited<ReturnType<typeof row>>;
    const results = await recovery.recoverEnabled({
      launch: async (installation) => {
        moved = await store.beginInstallationTransition({
          expectedGeneration: installation.generation,
          installationId,
          now: new Date(2),
          status: "stopping",
        });
        throw new Error("no launch");
      },
    });
    expect(results).toMatchObject([{ installationId, kind: "failed" }]);
    expect(await row()).toEqual(moved);
    expect(moved).toMatchObject({ startAttempts: 0, status: "stopping" });
  });

  it("surfaces a recovery settlement failure instead of reporting a persisted failure", async () => {
    const { recovery, row, store } = await interrupted();
    const before = await row();
    vi.spyOn(store, "transaction").mockRejectedValueOnce(
      new Error("storage unavailable")
    );
    await expect(
      recovery.recoverEnabled({
        launch: () => Promise.reject(new Error("no launch")),
      })
    ).rejects.toThrow("storage unavailable");
    expect(await row()).toEqual(before);
  });

  it("never cleans up a Program this process still runs as one a previous process left", async () => {
    const { programs, recovery, row } = await interrupted();
    expect(
      await recovery.recoverEnabled({ launch: () => Promise.resolve(launch) })
    ).toEqual([{ installationId, kind: "started" }]);
    const running = await programs.active(installationId);
    await recovery.normalizeInterrupted();
    const fenced = await row();

    const [result] = await recovery.recoverEnabled({
      launch: () => Promise.reject(new Error("no launch")),
    });
    expect(result).toMatchObject({ installationId, kind: "failed" });
    expect(result?.kind === "failed" ? result.error : undefined).toMatchObject({
      errors: [{ message: "no launch" }, { code: "already-active" }],
    });
    expect(await programs.active(installationId)).toEqual(running);
    expect(await row()).toEqual(fenced);
  });

  it("counts a failed supervisor start once", async () => {
    const { recovery, row, start, store } = await interrupted();
    const read = await row();
    const settle = vi.spyOn(store, "settleInstallationStatus");
    start.mockRejectedValueOnce(new Error("container refused"));
    expect(
      await recovery.recoverEnabled({ launch: () => Promise.resolve(launch) })
    ).toMatchObject([{ installationId, kind: "failed" }]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0]?.[0].expectedGeneration).toBe(
      (read?.generation ?? 0) + 1
    );
    expect(await row()).toMatchObject({ startAttempts: 1, status: "failed" });
  });
});
