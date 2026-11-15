import { describe, expect, it, vi } from "vitest";

import {
  type AccessRegistry,
  createModuleAccess,
  ModuleAccessError,
} from "../access";
import { installationIdSchema } from "../domain";
import { ModuleStoreConflictError } from "../errors";
import { ensureInstallation } from "../management";
import type { ModuleRegistry } from "../registry";
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
 * `registry`, whose transactions hand their work a registry that revokes
 * through `registry` and then fails, before the transaction commits.
 */
function failingAfterRevokeWrite(registry: ModuleRegistry): AccessRegistry {
  return {
    loadGatewayContext: (id) => registry.loadGatewayContext(id),
    replaceInstallationGrants: (input) =>
      registry.replaceInstallationGrants(input),
    revokeInstallationGrant: (input) => registry.revokeInstallationGrant(input),
    transaction: (work) =>
      registry.transaction((inner) =>
        work({
          loadGatewayContext: (id) => inner.loadGatewayContext(id),
          replaceInstallationGrants: (input) =>
            inner.replaceInstallationGrants(input),
          async revokeInstallationGrant(input) {
            await inner.revokeInstallationGrant(input);
            throw new Error("Failed after the write, before the commit");
          },
        })
      ),
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

  describe("cancellation follows the commit", () => {
    async function approved() {
      const fixed = await fixture();
      await fixed.access.approve({
        capability: WEATHER,
        installation: fixed.installation,
        version: fixed.version,
      });
      const accessOver = (store: AccessRegistry) =>
        createModuleAccess({
          invocations: fixed.invocations,
          providers: [weatherProvider],
          store,
        });
      return { ...fixed, accessOver };
    }

    it("cancels nothing when a revoke rolls back", async () => {
      const { accessOver, invocations, store } = await approved();
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

    it("cancels nothing when a carry-over rolls back", async () => {
      const { accessOver, installation, invocations, store } = await approved();
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

    it.each(["revoke", "carryOver"] as const)(
      "%s cancels once its own transaction has committed",
      async (operation) => {
        const { accessOver, installation, invocations, store } =
          await approved();
        let committed = false;
        const watched: AccessRegistry = {
          loadGatewayContext: (id) => store.loadGatewayContext(id),
          replaceInstallationGrants: (input) =>
            store.replaceInstallationGrants(input),
          revokeInstallationGrant: (input) =>
            store.revokeInstallationGrant(input),
          async transaction(work) {
            const result = await store.transaction(work);
            committed = true;
            return result;
          },
        };
        const cancelledAfterCommit: boolean[] = [];
        invocations.revoke.mockImplementation(() => {
          cancelledAfterCommit.push(committed);
        });
        const access = accessOver(watched);
        await (operation === "revoke"
          ? access.revoke({ capability: WEATHER, installationId })
          : access.carryOver({
              expectedGeneration: installation.generation,
              installationId,
              requests: [],
            }));

        expect(cancelledAfterCommit).toEqual([true]);
        expect(invocations.revoke).toHaveBeenCalledWith({
          capability: WEATHER,
          installationId,
          reason: "The Grant was revoked",
        });
      }
    );
  });
});
