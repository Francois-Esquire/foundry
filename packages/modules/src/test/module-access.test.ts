import { ArtifactApplicationError } from "@foundry/artifacts";
import { describe, expect, it, vi } from "vitest";

import { createModuleAccess, ModuleAccessError } from "../access";
import { installationIdSchema } from "../domain";
import { ensureInstallation } from "../management";
import { type ModuleStore, ModuleStoreConflictError } from "../store/contract";
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

/**
 * An approved Grant in Artifact-backed records, whose host binding fails
 * once `failApply` is set: the records commit, then applying them throws.
 */
async function durableFixture() {
  const module = await publishedModule({ store: "artifact" });
  const version = await module.publish("1.0.0", [weatherRequest(["Oslo"])]);
  const host: { failApply: boolean } = { failApply: false };
  module.artifacts.bind(() =>
    host.failApply
      ? Promise.reject(new Error("ENOSPC: no space left on device"))
      : Promise.resolve()
  );
  const installation = await ensureInstallation({
    installationId,
    now: new Date(0),
    store: module.store,
    version,
  });
  const invocations = { revoke: vi.fn() };
  const accessOver = (store: ModuleStore) =>
    createModuleAccess({ invocations, providers: [weatherProvider], store });
  await accessOver(module.store).approve({
    capability: WEATHER,
    installation,
    version,
  });
  return { ...module, accessOver, host, installation, invocations };
}

/** A Store whose revoke writes, then fails before the unit commits. */
function failingAfterRevokeWrite(store: ModuleStore): ModuleStore {
  return {
    ...store,
    async revokeInstallationGrant(
      input: Parameters<ModuleStore["revokeInstallationGrant"]>[0]
    ) {
      await store.revokeInstallationGrant(input);
      throw new Error("Failed after the write, before the commit");
    },
  };
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

  it.each([false, true])(
    "refuses stale carry-over when Grants are kept: %s",
    async (keep) => {
      const { access, installation, store, version } = await fixture();
      await access.approve({ capability: WEATHER, installation, version });
      await expect(
        access.carryOver({
          expectedGeneration: installation.generation + 1,
          installationId,
          requests: keep
            ? await access.requests({ installation, version })
            : [],
        })
      ).rejects.toThrow(ModuleStoreConflictError);
      expect(
        (await store.loadGatewayContext(installationId))?.grants
      ).toHaveLength(1);
    }
  );

  describe("over durable records", () => {
    it("cancels a revoked Grant's Invocations when its commit applies to the host and fails", async () => {
      const { accessOver, host, invocations, store } = await durableFixture();
      host.failApply = true;
      const failure = await accessOver(store)
        .revoke({ capability: WEATHER, installationId })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ArtifactApplicationError);
      expect((await store.loadGatewayContext(installationId))?.grants).toEqual(
        []
      );
      expect(invocations.revoke).toHaveBeenCalledExactlyOnceWith({
        capability: WEATHER,
        installationId,
        reason: "The Grant was revoked",
      });
    });

    it("cancels nothing when a revoke rolls back", async () => {
      const { accessOver, invocations, store } = await durableFixture();
      await expect(
        accessOver(failingAfterRevokeWrite(store)).revoke({
          capability: WEATHER,
          installationId,
        })
      ).rejects.toThrow("Failed after the write, before the commit");

      expect(
        (await store.loadGatewayContext(installationId))?.grants
      ).toHaveLength(1);
      expect(invocations.revoke).not.toHaveBeenCalled();
    });

    it("cancels Grants a carry-over dropped when its commit applies to the host and fails", async () => {
      const { accessOver, host, installation, invocations, store } =
        await durableFixture();
      host.failApply = true;
      const failure = await accessOver(store)
        .carryOver({
          expectedGeneration: installation.generation,
          installationId,
          requests: [],
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ArtifactApplicationError);
      expect((await store.loadGatewayContext(installationId))?.grants).toEqual(
        []
      );
      expect(invocations.revoke).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ capability: WEATHER, installationId })
      );
    });

    it("cancels nothing when a carry-over rolls back", async () => {
      const { accessOver, installation, invocations, store } =
        await durableFixture();
      await expect(
        accessOver(failingAfterRevokeWrite(store)).carryOver({
          expectedGeneration: installation.generation,
          installationId,
          requests: [],
        })
      ).rejects.toThrow("Failed after the write, before the commit");

      expect(
        (await store.loadGatewayContext(installationId))?.grants
      ).toHaveLength(1);
      expect(invocations.revoke).not.toHaveBeenCalled();
    });
  });
  // Contract: an Access operation may join an outer unit. Returning from the
  // operation is not a commit: cancellation waits for the outermost durable
  // commit, is discarded on rollback, and survives host application failure.
  describe.each(["revoke", "carryOver"] as const)(
    "outermost commit for %s",
    (operation) => {
      async function prepared() {
        const fixed = await durableFixture();
        const access = fixed.accessOver(fixed.store);
        const revoke = () =>
          operation === "revoke"
            ? access.revoke({ capability: WEATHER, installationId })
            : access.carryOver({
                expectedGeneration: fixed.installation.generation,
                installationId,
                requests: [],
              });
        return { ...fixed, revoke };
      }
      it("cancels after standalone success", async () => {
        const { revoke, invocations, store } = await prepared();
        await revoke();
        expect(invocations.revoke).toHaveBeenCalledTimes(1);
        expect(
          (await store.loadGatewayContext(installationId))?.grants
        ).toEqual([]);
      });
      it("waits for the outer success before cancelling", async () => {
        const { revoke, invocations, store } = await prepared();
        await store.transaction(async () => {
          await revoke();
          expect(invocations.revoke).not.toHaveBeenCalled();
        });
        expect(invocations.revoke).toHaveBeenCalledTimes(1);
      });
      it("discards cancellation on outer rollback and preserves the original error", async () => {
        const { revoke, invocations, store } = await prepared();
        const original = new Error("outer rollback");
        await expect(
          store.transaction(async () => {
            await revoke();
            expect(invocations.revoke).not.toHaveBeenCalled();
            throw original;
          })
        ).rejects.toBe(original);
        expect(
          (await store.loadGatewayContext(installationId))?.grants
        ).toHaveLength(1);
        expect(invocations.revoke).not.toHaveBeenCalled();
      });
      it("cancels after outer commit even when applying it fails", async () => {
        const { revoke, invocations, store, host } = await prepared();
        host.failApply = true;
        await expect(
          store.transaction(async () => {
            await revoke();
            expect(invocations.revoke).not.toHaveBeenCalled();
          })
        ).rejects.toBeInstanceOf(ArtifactApplicationError);
        expect(
          (await store.loadGatewayContext(installationId))?.grants
        ).toEqual([]);
        expect(invocations.revoke).toHaveBeenCalledTimes(1);
      });
    }
  );
});
