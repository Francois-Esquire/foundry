import { describe, expect, it, vi } from "vitest";

import { createModuleAccess } from "../access";
import { installationIdSchema } from "../domain";
import { ensureInstallation } from "../management";
import {
  createModuleInstallations,
  ModuleActivationRefusedError,
} from "../platform/installations";
import { createModuleRuntimeRecovery } from "../platform/runtime-recovery";
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

async function fixture() {
  const module = await publishedModule();
  const v1 = await module.publish("1.0.0", [weatherRequest(["Oslo"])]);
  const invocations = { revoke: vi.fn() };
  /** What the selected checkout did, in order. */
  const checkout: string[] = [];
  const installations = createModuleInstallations({
    checkouts: {
      async select(version, record) {
        checkout.push(`swap ${version.contentId}`);
        try {
          return await record();
        } catch (error) {
          checkout.push("restore");
          throw error;
        }
      },
    },
    invocations,
    programs: module.programs,
    providers: [weatherProvider],
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
  return { ...module, access, checkout, installation, installations, v1 };
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
      programs,
      publish,
      store,
      v1,
    } = await fixture();
    await access.approve({ capability: WEATHER, installation, version: v1 });
    const v2 = await publish("2.0.0", [weatherRequest(["Rome"])]);
    vi.spyOn(programs, "selectVersion").mockRejectedValueOnce(
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
