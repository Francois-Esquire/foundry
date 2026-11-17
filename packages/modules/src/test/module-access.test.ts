import { describe, expect, it, vi } from "vitest";

import {
  type AccessRegistry,
  createModuleAccess,
  ModuleAccessError,
} from "../access";
import { installationIdSchema } from "../domain";
import { ModuleStoreConflictError } from "../errors";
import { ensureInstallation } from "../management";
import { ModuleRegistry } from "../registry";
import type { ModuleStore } from "../store";
import { MemoryModuleStore } from "../store/memory";
import { SqliteModuleStore } from "../store/sqlite";
import { libsqlDatabases } from "./helpers/sqlite";

const sqliteDatabases = libsqlDatabases("memory");

import {
  publishedModule,
  WEATHER,
  weatherProvider,
  weatherRequest,
} from "./helpers/published-module";

const installationId = installationIdSchema.parse("forecast-installation");

async function fixture(
  capabilities = [weatherRequest(["Oslo"])],
  registry?: ModuleRegistry
) {
  const module = await publishedModule(
    registry === undefined ? {} : { registry }
  );
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

function failingAfterRevokeWrite(registry: ModuleRegistry): AccessRegistry {
  return {
    loadGatewayContext: (id) => registry.loadGatewayContext(id),
    replaceInstallationGrants: (input) =>
      registry.replaceInstallationGrants(input),
    revokeInstallationGrant: (input) => registry.revokeInstallationGrant(input),
    transaction: (work) =>
      registry.transaction((inner, effects) =>
        work(
          {
            loadGatewayContext: (id) => inner.loadGatewayContext(id),
            replaceInstallationGrants: (input) =>
              inner.replaceInstallationGrants(input),
            async revokeInstallationGrant(input) {
              await inner.revokeInstallationGrant(input);
              throw new Error("Failed after the write, before the commit");
            },
          },
          effects
        )
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

    it("cancels every Grant a carry-over dropped, though one cancellation fails", async () => {
      const { accessOver, installation, invocations, store } = await approved();
      const second = {
        capability: "host.news.read",
        constraintsDigest: "news",
        version: 1,
      };
      const held = await store.loadGatewayContext(installationId);
      await store.replaceInstallationGrants({
        expectedGeneration: installation.generation,
        grants: [...(held?.grants ?? []), second],
        installationId,
        now: new Date(0),
      });
      invocations.revoke.mockImplementationOnce(() => {
        throw new Error("cancellation failed");
      });

      await expect(
        accessOver(store).carryOver({
          expectedGeneration: installation.generation,
          installationId,
          requests: [],
        })
      ).rejects.toThrow("cancellation failed");

      expect((await store.loadGatewayContext(installationId))?.grants).toEqual(
        []
      );
      expect(
        invocations.revoke.mock.calls.map(([call]) => call.capability)
      ).toEqual([second.capability, WEATHER].sort());
    });

    it.each(["revoke", "carryOver"] as const)(
      "%s cancels once its store transaction has committed, and never before",
      async (operation) => {
        const memory = new MemoryModuleStore();
        let committed = false;
        const watched: ModuleStore = {
          commit: (write) => memory.commit(write),
          getInstallation: (id) => memory.getInstallation(id),
          getManifest: (contentId) => memory.getManifest(contentId),
          getModule: (id) => memory.getModule(id),
          listInstallations: (query) => memory.listInstallations(query),
          listManifests: (query) => memory.listManifests(query),
          listModules: (query) => memory.listModules(query),
          async transaction(work) {
            committed = false;
            const result = await memory.transaction(work);
            committed = true;
            return result;
          },
        };
        const fixed = await fixture(
          undefined,
          new ModuleRegistry({ store: watched })
        );
        await fixed.access.approve({
          capability: WEATHER,
          installation: fixed.installation,
          version: fixed.version,
        });
        const cancelledAfterCommit: boolean[] = [];
        fixed.invocations.revoke.mockImplementation(() => {
          cancelledAfterCommit.push(committed);
        });
        await (operation === "revoke"
          ? fixed.access.revoke({ capability: WEATHER, installationId })
          : fixed.access.carryOver({
              expectedGeneration: fixed.installation.generation,
              installationId,
              requests: [],
            }));

        expect(cancelledAfterCommit).toEqual([true]);
        expect(fixed.invocations.revoke).toHaveBeenCalledWith({
          capability: WEATHER,
          installationId,
          reason: "The Grant was revoked",
        });
      }
    );

    it("refuses to run over a registry bound to a transaction, so an outer rollback cannot follow a cancellation", async () => {
      const { invocations, store } = await approved();
      const original = new Error("outer rollback");
      await expect(
        store.transaction(async (registry) => {
          expect(() =>
            createModuleAccess({
              invocations,
              providers: [weatherProvider],
              store: registry,
            })
          ).toThrow('durability "host"');
          await registry.revokeInstallationGrant({
            capability: WEATHER,
            expectedGeneration: 0,
            installationId,
          });
          throw original;
        })
      ).rejects.toBe(original);

      expect(
        (await store.loadGatewayContext(installationId))?.grants
      ).toHaveLength(1);
      expect(invocations.revoke).not.toHaveBeenCalled();
    });

    it("refuses a registry over a SQLite store inside a host transaction", async () => {
      const database = await sqliteDatabases.open();
      await database
        .transaction(async (transaction) => {
          const registry = new ModuleRegistry({
            store: new SqliteModuleStore({ database: transaction, scope: "s" }),
          });
          expect(registry.durability).toBe("host");
          expect(() =>
            createModuleAccess({ providers: [], store: registry })
          ).toThrow('durability "host"');
          throw new Error("host rolled back");
        })
        .catch(() => undefined);
    });
  });
});
