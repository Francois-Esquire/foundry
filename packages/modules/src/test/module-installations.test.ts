import { describe, expect, it, vi } from "vitest";
import { createModuleAccess } from "../access";
import { installationIdSchema } from "../domain";
import { ensureInstallation } from "../management";
import { validateModuleActivation } from "../platform/activation";
import {
  createModuleInstallations,
  ModuleActivationRefusedError,
} from "../platform/installations";
import { createModuleRuntimeRecovery } from "../platform/runtime-recovery";
import { KeyedTurns } from "../platform/turns";
import { MODULE_SETTING_HOST_POLICY } from "../settings";
import { ModuleStoreConflictError } from "../store/contract";
import {
  publishedModule,
  WEATHER,
  weatherProvider,
  weatherRequest,
} from "./helpers/published-module";

const installationId = installationIdSchema.parse("forecast-installation");
const launch = {
  files: "installation" as const,
  resources: { cpus: 1, memoryBytes: 268_435_456 },
};
const settings = { policy: MODULE_SETTING_HOST_POLICY, user: {} };

async function fixture(providers = [weatherProvider]) {
  const module = await publishedModule();
  const v1 = await module.publish("1.0.0", [weatherRequest(["Oslo"])]);
  const invocations = { revoke: vi.fn() };
  /** What the selected checkout did, in order. */
  const checkout: string[] = [];
  /** The checkout's per-Module turn, which a Program start also takes. */
  const moduleTurns = new KeyedTurns<string>();
  const installations = createModuleInstallations({
    checkouts: {
      select: (version, record) =>
        moduleTurns.run(version.moduleId, async () => {
          checkout.push(`swap ${version.contentId}`);
          try {
            return await record();
          } catch (error) {
            checkout.push("restore");
            throw error;
          }
        }),
    },
    invocations,
    programs: module.programs,
    providers,
    store: module.store,
  });
  const access = createModuleAccess({
    providers: [weatherProvider],
    store: module.store,
  });
  const installation = await ensureInstallation({
    installationId,
    now: new Date(0),
    store: module.store,
    version: v1,
  });
  return {
    ...module,
    access,
    checkout,
    installation,
    installations,
    invocations,
    moduleTurns,
    v1,
  };
}

describe("Module installation lifecycle", () => {
  it("ensures one Installation per id, created disabled at the Version", async () => {
    const { installation, store, v1 } = await fixture();
    expect(installation).toMatchObject({
      contentId: v1.contentId,
      generation: 0,
      status: "disabled",
    });
    expect(
      await ensureInstallation({
        installationId,
        now: new Date(1),
        store,
        version: v1,
      })
    ).toEqual(installation);
  });

  it("selects a Version inside the selected checkout, carrying over unchanged Grants", async () => {
    const {
      access,
      checkout,
      installation,
      installations,
      publish,
      store,
      v1,
    } = await fixture();
    await access.approve({ capability: WEATHER, installation, version: v1 });
    const v2 = await publish("2.0.0", [weatherRequest(["Oslo"])]);
    const selected = await installations.selectVersion({
      installation,
      version: v2,
    });
    expect(selected).toMatchObject({
      contentId: v2.contentId,
      generation: installation.generation + 1,
    });
    expect(checkout).toEqual([`swap ${v2.contentId}`]);
    expect(
      (await store.loadGatewayContext(installationId))?.grants.map(
        (grant) => grant.capability
      )
    ).toEqual([WEATHER]);
  });

  it("loses a changed Grant even when recording the selection fails, and restores the checkout", async () => {
    const {
      access,
      checkout,
      installation,
      installations,
      publish,
      store,
      v1,
    } = await fixture();
    await access.approve({ capability: WEATHER, installation, version: v1 });
    const v2 = await publish("2.0.0", [weatherRequest(["Rome"])]);
    vi.spyOn(store, "selectInstallationVersion").mockRejectedValueOnce(
      new Error("store unavailable")
    );
    await expect(
      installations.selectVersion({ installation, version: v2 })
    ).rejects.toThrow("store unavailable");
    const context = await store.loadGatewayContext(installationId);
    expect(context?.installation.contentId).toBe(v1.contentId);
    expect(context?.grants).toEqual([]);
    expect(checkout).toEqual([`swap ${v2.contentId}`, "restore"]);
  });

  it("refuses a stale selection before the checkout records anything", async () => {
    const { installation, installations, publish, store, v1 } = await fixture();
    const v2 = await publish("2.0.0");
    await installations.selectVersion({ installation, version: v2 });
    await expect(
      installations.selectVersion({ installation, version: v1 })
    ).rejects.toThrow("generation");
    expect(
      (await store.loadGatewayContext(installationId))?.installation.contentId
    ).toBe(v2.contentId);
  });

  it("refuses to select a Version for a running Installation before revoking or swapping anything", async () => {
    const {
      access,
      checkout,
      installation,
      installations,
      invocations,
      publish,
      store,
      v1,
    } = await fixture();
    await access.approve({ capability: WEATHER, installation, version: v1 });
    await installations.start({ installation, launch, settings, version: v1 });
    const active = await store.loadGatewayContext(installationId);
    const v2 = await publish("2.0.0", [weatherRequest(["Rome"])]);

    await expect(
      installations.selectVersion({
        installation: active?.installation ?? installation,
        version: v2,
      })
    ).rejects.toMatchObject({ code: "already-active" });
    const after = await store.loadGatewayContext(installationId);
    expect(after?.installation).toMatchObject({
      contentId: v1.contentId,
      status: "active",
    });
    expect(after?.grants.map((grant) => grant.capability)).toEqual([WEATHER]);
    expect(checkout).toEqual([]);
    expect(invocations.revoke).not.toHaveBeenCalled();
  });

  it("takes the Installation's turn before the checkout's, as a start does", async () => {
    const {
      access,
      installation,
      installations,
      moduleTurns,
      moduleId,
      publish,
      start,
      store,
      v1,
    } = await fixture();
    await access.approve({ capability: WEATHER, installation, version: v1 });
    const v2 = await publish("2.0.0", [weatherRequest(["Oslo"])]);
    // A container start projects the checkout inside the supervisor's turn.
    const launched = start.getMockImplementation();
    start.mockImplementation(() =>
      moduleTurns.run(moduleId, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return launched?.() as never;
      })
    );
    const started = installations.start({
      installation,
      launch,
      settings,
      version: v1,
    });
    const selected = installations.selectVersion({ installation, version: v2 });

    await expect(started).resolves.toBeDefined();
    await expect(selected).rejects.toMatchObject({ code: "stale-generation" });
    expect(
      (await store.loadGatewayContext(installationId))?.installation.status
    ).toBe("active");
  });

  it("takes the Installation's turn first even against a start that bypasses these calls", async () => {
    const {
      access,
      installation,
      installations,
      moduleTurns,
      moduleId,
      programs,
      publish,
      start,
      store,
      v1,
    } = await fixture();
    await access.approve({ capability: WEATHER, installation, version: v1 });
    const v2 = await publish("2.0.0", [weatherRequest(["Oslo"])]);
    const launched = start.getMockImplementation();
    start.mockImplementation(() =>
      moduleTurns.run(moduleId, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return launched?.() as never;
      })
    );
    // Recovery starts through the supervisor, outside the facade's queue.
    const started = programs.start({
      expectedGeneration: installation.generation,
      installationId,
      launch,
    });
    const selected = installations.selectVersion({ installation, version: v2 });
    const settled = Promise.allSettled([started, selected]);
    const deadlocked = new Promise<"deadlocked">((resolve) =>
      setTimeout(() => resolve("deadlocked"), 1000)
    );

    const outcome = await Promise.race([settled, deadlocked]);
    expect(outcome).not.toBe("deadlocked");
    await expect(started).resolves.toBeDefined();
    await expect(selected).rejects.toMatchObject({ code: "stale-generation" });
    expect(
      (await store.loadGatewayContext(installationId))?.installation.status
    ).toBe("active");
  });

  it("stops the Program a start called just before it brought up", async () => {
    const { access, installation, installations, programs, store, v1 } =
      await fixture();
    await access.approve({ capability: WEATHER, installation, version: v1 });
    const started = installations.start({
      installation,
      launch,
      settings,
      version: v1,
    });
    const stopped = installations.stop({ installationId, reason: "Closed" });

    await started;
    await expect(stopped).resolves.toBeUndefined();
    expect(
      (await store.loadGatewayContext(installationId))?.installation.status
    ).toBe("disabled");
    expect(await programs.active(installationId)).toBeNull();
  });

  it("refuses launch persistence mismatches and resources outside the Module's or host's limits", async () => {
    const { installations, publish, start, store } = await fixture();
    const v2 = await publish("2.0.0", [], {
      persistence: { files: "none" },
      resources: { memoryBytes: 512 * 1024 * 1024 },
    });
    const selected = (await store.loadGatewayContext(installationId))
      ?.installation;
    if (!selected) {
      throw new Error("expected the Installation");
    }
    const current = await installations.selectVersion({
      installation: selected,
      version: v2,
    });
    const below = installations.start({
      installation: current,
      launch,
      settings,
      version: v2,
    });
    await expect(below).rejects.toThrow(ModuleActivationRefusedError);
    await expect(below).rejects.toMatchObject({
      facts: expect.arrayContaining([
        {
          blocking: true,
          detail: expect.any(String),
          kind: "unsupported-requirement",
        },
      ]),
    });
    await expect(
      installations.start({
        installation: current,
        launch: {
          ...launch,
          resources: { cpus: 64, memoryBytes: 512 * 1024 * 1024 },
        },
        settings,
        version: v2,
      })
    ).rejects.toThrow("resources.cpus");
    await expect(
      installations.start({
        installation: current,
        launch: {
          ...launch,
          resources: { cpus: 1, memoryBytes: 512 * 1024 * 1024 },
        },
        settings,
        version: v2,
      })
    ).rejects.toThrow('the Module requires "none"');
    expect(start).not.toHaveBeenCalled();
    await installations.start({
      installation: current,
      launch: {
        ...launch,
        files: "none",
        resources: { cpus: 1, memoryBytes: 512 * 1024 * 1024 },
      },
      settings,
      version: v2,
    });
    expect(start).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "releases a policy wait on caller cancellation or host shutdown: %s",
    async (shutdown) => {
      const { programs, installation, v1, store, start } = await fixture();
      const entered = Promise.withResolvers<void>();
      const policy = Promise.withResolvers<{ constraintsDigest: string }>();
      const provider = {
        ...weatherProvider,
        resolveConstraints: () => {
          entered.resolve();
          return policy.promise;
        },
      };
      const caller = new AbortController();
      const running = programs.activate({
        installation,
        launch,
        providers: [provider],
        settings,
        signal: caller.signal,
        version: v1,
      });
      // Attach before aborting so a synchronous rejection is always observed.
      const rejected = expect(running).rejects.toBeDefined();
      await entered.promise;
      if (shutdown) {
        await programs.shutdown("host shutdown");
      } else {
        caller.abort(new Error("caller cancelled"));
      }
      await rejected;
      await programs.stop({ installationId, reason: "after cancelled policy" });
      expect(
        (await store.loadGatewayContext(installationId))?.installation
      ).toMatchObject({ generation: 0, status: "disabled" });
      policy.resolve({ constraintsDigest: "late result" });
      await policy.promise;
      expect(start).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])(
    "restores a staged checkout and releases selection on cancellation or shutdown: %s",
    async (shutdown) => {
      const entered = Promise.withResolvers<void>();
      const policy = Promise.withResolvers<{ constraintsDigest: string }>();
      const provider = {
        ...weatherProvider,
        resolveConstraints: () => {
          entered.resolve();
          return policy.promise;
        },
      };
      const { installations, programs, installation, v1, store, checkout } =
        await fixture([provider]);
      const caller = new AbortController();
      const selected = installations.selectVersion({
        installation,
        signal: caller.signal,
        version: v1,
      });
      const rejected = expect(selected).rejects.toBeDefined();
      await entered.promise;
      if (shutdown) {
        await programs.shutdown("host shutdown");
      } else {
        caller.abort(new Error("caller cancelled"));
      }
      await rejected;
      expect(checkout).toEqual([`swap ${v1.contentId}`, "restore"]);
      expect(
        (await store.loadGatewayContext(installationId))?.installation
      ).toMatchObject({
        contentId: v1.contentId,
        generation: 0,
        status: "disabled",
      });
      policy.resolve({ constraintsDigest: "late result" });
      await policy.promise;
    }
  );

  it("keeps raw host start policy-free while activate refuses an unapproved request", async () => {
    const { programs, installation, v1, store } = await fixture();
    await expect(
      programs.activate({
        installation,
        launch,
        providers: [weatherProvider],
        settings,
        version: v1,
      })
    ).rejects.toThrow(ModuleActivationRefusedError);
    expect(
      (await store.loadGatewayContext(installationId))?.installation.generation
    ).toBe(0);
    // Host-resolved raw starts are supported; Gateway admission still checks Grants.
    await expect(
      programs.start({
        expectedGeneration: installation.generation,
        installationId,
        launch,
      })
    ).resolves.toBeDefined();
    expect((await store.loadGatewayContext(installationId))?.grants).toEqual(
      []
    );
  });

  it("refuses to start an unapproved required Capability before acquiring anything", async () => {
    const { installation, installations, start, v1 } = await fixture();
    const refused = installations.start({
      installation,
      launch,
      settings,
      version: v1,
    });
    await expect(refused).rejects.toThrow(ModuleActivationRefusedError);
    await expect(refused).rejects.toMatchObject({
      facts: [{ blocking: true, kind: "ungranted-capability" }],
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("starts at the selected generation once approved, and stops at the current one", async () => {
    const { access, installation, installations, store, v1 } = await fixture();
    await access.approve({ capability: WEATHER, installation, version: v1 });
    const { runtime } = await installations.start({
      installation,
      launch,
      settings,
      version: v1,
    });
    const started = await store.loadGatewayContext(installationId);
    expect(started?.installation.status).toBe("active");
    expect(runtime.generation).toBe(started?.installation.generation);

    await installations.stop({ installationId, reason: "Closed" });
    expect(
      (await store.loadGatewayContext(installationId))?.installation.status
    ).toBe("disabled");
    await expect(
      installations.stop({
        installationId: installationIdSchema.parse("missing"),
        reason: "Closed",
      })
    ).resolves.toBeUndefined();
  });

  it("refuses to start a Version the Installation no longer selects", async () => {
    const { installation, installations, publish, start, v1 } = await fixture();
    const v2 = await publish("2.0.0");
    const selected = await installations.selectVersion({
      installation,
      version: v2,
    });
    await expect(
      installations.start({ installation, launch, settings, version: v1 })
    ).rejects.toThrow(ModuleStoreConflictError);
    await expect(
      installations.start({
        installation: selected,
        launch,
        settings,
        version: v1,
      })
    ).rejects.toThrow(ModuleStoreConflictError);
    expect(start).not.toHaveBeenCalled();
  });

  it("stops occurrences a previous process left starting instead of restarting them", async () => {
    const { installation, programs, start, store } = await fixture();
    // A previous process died while its Program was starting.
    await store.beginInstallationTransition({
      expectedGeneration: installation.generation,
      installationId,
      now: new Date(1),
      status: "starting",
    });
    const before = await store.loadGatewayContext(installationId);
    const recovery = createModuleRuntimeRecovery({
      store,
      supervisor: programs,
    });
    await recovery.stopInterrupted("Host restarted");
    const after = await store.loadGatewayContext(installationId);
    expect(after?.installation.status).toBe("disabled");
    expect(after?.installation.generation).toBeGreaterThan(
      before?.installation.generation ?? 0
    );
    expect(start).not.toHaveBeenCalled();
  });
});

describe("Interrupted occurrences' retained containers", () => {
  /**
   * A previous process died with the Installation `status`, its container
   * still linked. This process has no Program for it.
   */
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
    // Later in ID order: a Program a previous process left running.
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
});

describe("Module boot recovery attempts", () => {
  /** A previous process died with the Installation enabled. */
  async function interrupted() {
    const fixed = await fixture();
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

    // The next boot leaves the operator's `failed` alone.
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

  it("counts a failed supervisor start once", async () => {
    const { recovery, row, start, store } = await interrupted();
    const read = await row();
    const settle = vi.spyOn(store, "settleInstallationStatus");
    start.mockRejectedValueOnce(new Error("container refused"));
    expect(
      await recovery.recoverEnabled({ launch: () => Promise.resolve(launch) })
    ).toMatchObject([{ installationId, kind: "failed" }]);
    expect(start).toHaveBeenCalledTimes(1);
    // Only the supervisor settled it, at the generation its attempt began.
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0]?.[0].expectedGeneration).toBe(
      (read?.generation ?? 0) + 1
    );
    expect(await row()).toMatchObject({ startAttempts: 1, status: "failed" });
  });
});
