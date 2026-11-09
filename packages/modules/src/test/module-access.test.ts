import { describe, expect, it, vi } from "vitest";

import { createModuleAccess, ModuleAccessError } from "../access";
import { installationIdSchema } from "../domain";
import { ensureInstallation } from "../management";
import { ModuleStoreConflictError } from "../store/contract";
import {
  publishedModule,
  WEATHER,
  weatherProvider,
  weatherRequest,
} from "./helpers/published-module";

const installationId = installationIdSchema.parse("forecast-installation");

async function fixture(capabilities = [weatherRequest(["Oslo"])]) {
  const module = await publishedModule();
  const version = await module.publish("1.0.0", capabilities);
  const installation = await ensureInstallation({
    installationId,
    now: new Date(0),
    store: module.store,
    version,
  });
  const invocations = { revoke: vi.fn() };
  const access = createModuleAccess({
    invocations,
    providers: [weatherProvider],
    store: module.store,
  });
  return { ...module, access, installation, invocations, version };
}

describe("Module access", () => {
  it("approves a request at its resolved digest and revokes it, cancelling its Invocations", async () => {
    const { access, installation, invocations, store, version } =
      await fixture();
    const { grants, request } = await access.approve({
      capability: WEATHER,
      installation,
      version,
    });
    expect(request.constraintsDigest).toBe('cities:{"cities":["Oslo"]}');
    expect(grants).toMatchObject([
      { capability: WEATHER, constraintsDigest: request.constraintsDigest },
    ]);

    await access.revoke({ capability: WEATHER, installationId });
    expect((await store.loadGatewayContext(installationId))?.grants).toEqual(
      []
    );
    expect(invocations.revoke).toHaveBeenCalledWith({
      capability: WEATHER,
      installationId,
      reason: "The Grant was revoked",
    });
    await expect(
      access.revoke({ capability: WEATHER, installationId })
    ).rejects.toThrow(`${WEATHER} is not approved`);
  });

  it("refuses an approval the Version does not request or the host cannot provide", async () => {
    const { access, installation, store, version } = await fixture();
    await expect(
      access.approve({ capability: "host.other", installation, version })
    ).rejects.toThrow("Version 1.0.0 does not request host.other");

    const unavailable = createModuleAccess({ providers: [], store });
    await expect(
      unavailable.approve({ capability: WEATHER, installation, version })
    ).rejects.toThrow(
      new ModuleAccessError(
        `This host cannot provide ${WEATHER}, so it cannot be approved`
      )
    );
  });

  it("refuses an approval read at a stale generation or Version", async () => {
    const { access, installation, programs, publish, store, version } =
      await fixture();
    const next = await publish("1.1.0", [weatherRequest(["Oslo"])]);
    await programs.selectVersion({
      contentId: next.contentId,
      expectedGeneration: installation.generation,
      installationId,
    });
    await expect(
      access.approve({ capability: WEATHER, installation, version })
    ).rejects.toThrow("The Installation changed while approving");
    expect((await store.loadGatewayContext(installationId))?.grants).toEqual(
      []
    );
  });

  it("carries over only Grants whose request is unchanged and revokes the rest first", async () => {
    const { access, installation, invocations, publish, store, version } =
      await fixture([weatherRequest(["Oslo"])]);
    await access.approve({ capability: WEATHER, installation, version });
    const same = await publish("1.1.0", [weatherRequest(["Oslo"])]);
    const kept = await access.carryOver({
      expectedGeneration: installation.generation,
      installationId,
      requests: await access.requests({ installation, version: same }),
    });
    expect(kept.map((grant) => grant.capability)).toEqual([WEATHER]);
    expect(invocations.revoke).not.toHaveBeenCalled();

    // Wider constraints resolve to another digest: the Grant asks again.
    const wider = await publish("1.2.0", [weatherRequest(["Oslo", "Rome"])]);
    expect(
      await access.carryOver({
        expectedGeneration: installation.generation,
        installationId,
        requests: await access.requests({ installation, version: wider }),
      })
    ).toEqual([]);
    expect((await store.loadGatewayContext(installationId))?.grants).toEqual(
      []
    );
    expect(invocations.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ capability: WEATHER, installationId })
    );
  });

  it("refuses to carry Grants over at a stale generation", async () => {
    const { access, installation, store, version } = await fixture();
    await access.approve({ capability: WEATHER, installation, version });
    await expect(
      access.carryOver({
        expectedGeneration: installation.generation + 1,
        installationId,
        requests: [],
      })
    ).rejects.toThrow(ModuleStoreConflictError);
    expect(
      (await store.loadGatewayContext(installationId))?.grants
    ).toHaveLength(1);
  });
});
