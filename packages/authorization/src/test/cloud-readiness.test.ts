import { canonicalizeJson } from "@foundry/lib/json";
import { describe, expect, it } from "vitest";
import {
  Authorization,
  AuthorizationRevisionError,
  AuthorizationStateError,
  grantId,
} from "../index";
import type { AccessRequest, Principal } from "../scope";
import type { AuthorizationStore } from "../store/index";
import { MemoryAuthorizationStore } from "../store/memory";
import { SqliteAuthorizationStore } from "../store/sqlite";
import { libsqlDatabases } from "./helpers/sqlite";

const SHA256_HEX = /^[0-9a-f]{64}$/;

const USER: Principal = { id: "user-1", kind: "user" };
const AGENT: Principal = { id: "agent-1", kind: "agent" };

const REQUEST: AccessRequest = {
  action: "tool.call",
  attributes: { apiKey: "super-secret-token" },
  principal: AGENT,
  target: "deploy",
};

describe("Authorization cloud-native seams", () => {
  it("hashes requestFingerprint with SHA-256 without storing plaintext attributes", async () => {
    const store = new MemoryAuthorizationStore();
    let seq = 0;
    const auth = new Authorization({
      clock: () => 1000,
      generateId: (prefix) => {
        seq += 1;
        return `${prefix}_custom_${seq}`;
      },
      store,
    });

    const issued = await auth.grant({
      holder: { kind: "exact", principal: AGENT },
      requestedBy: USER,
      scope: {
        action: "tool.call",
        target: { kind: "exact", value: "deploy" },
      },
      usesRemaining: 1,
    });
    expect(issued.id).toBe("grt_custom_1");

    const outcome = await auth.authorize(REQUEST, "inv-hash-1");
    expect(outcome.kind).toBe("permitted");
    if (outcome.kind !== "permitted") {
      return;
    }
    outcome.permit.release();

    const claim = await store.getClaim("inv-hash-1");
    expect(claim?.requestFingerprint).toMatch(SHA256_HEX);
    expect(claim?.requestFingerprint).not.toContain("super-secret-token");

    const replayed = await auth.authorize(REQUEST, "inv-hash-1", {
      idempotent: true,
    });
    expect(replayed.kind).toBe("permitted");
    if (replayed.kind === "permitted") {
      replayed.permit.release();
    }
  });

  it("handles nested undefined properties in request attributes during fingerprinting, replay, and verifyReceipt()", async () => {
    const store = new MemoryAuthorizationStore();
    const auth = new Authorization({ clock: () => 1000, store });
    const issued = await auth.grant({
      holder: { kind: "exact", principal: AGENT },
      requestedBy: USER,
      scope: {
        action: "tool.call",
        target: { kind: "exact", value: "deploy" },
      },
    });

    const nestedRequest: AccessRequest = {
      action: "tool.call",
      attributes: {
        items: [{ keep: 1, omit: undefined }],
        nested: { deep: { a: "ok", b: undefined }, dropped: undefined },
        topDropped: undefined,
      } as unknown as AccessRequest["attributes"],
      principal: {
        ...AGENT,
        attributes: {
          meta: { region: "us", unused: undefined },
        } as unknown as Principal["attributes"],
      },
      target: "deploy",
    };

    const equivalentRequest: AccessRequest = {
      action: "tool.call",
      attributes: {
        items: [{ keep: 1 }],
        nested: { deep: { a: "ok" } },
      },
      principal: {
        ...AGENT,
        attributes: { meta: { region: "us" } },
      },
      target: "deploy",
    };

    const outcome = await auth.authorize(nestedRequest, "inv-nested-undef");
    expect(outcome.kind).toBe("permitted");
    if (outcome.kind !== "permitted") {
      return;
    }
    const { receipt } = outcome.permit;
    outcome.permit.release();

    const claim = await store.getClaim("inv-nested-undef");
    expect(claim?.requestFingerprint).toMatch(SHA256_HEX);

    const replayed = await auth.authorize(
      equivalentRequest,
      "inv-nested-undef",
      { idempotent: true }
    );
    expect(replayed.kind).toBe("permitted");
    if (replayed.kind === "permitted") {
      replayed.permit.release();
    }

    expect(await auth.verifyReceipt(receipt, equivalentRequest)).toEqual({
      grantId: issued.id,
      grantPath: [issued.id],
      kind: "allow",
    });
  });

  it("verifies receipts read-only before and after revocation", async () => {
    const store = new MemoryAuthorizationStore();
    const auth = new Authorization({ clock: () => 1000, store });
    const issued = await auth.grant({
      holder: { kind: "exact", principal: AGENT },
      requestedBy: USER,
      scope: {
        action: "tool.call",
        target: { kind: "exact", value: "deploy" },
      },
    });

    const outcome = await auth.authorize(REQUEST, "inv-verify-1");
    expect(outcome.kind).toBe("permitted");
    if (outcome.kind !== "permitted") {
      return;
    }
    const { receipt } = outcome.permit;
    outcome.permit.release();

    expect(await auth.verifyReceipt(receipt, REQUEST)).toEqual({
      grantId: issued.id,
      grantPath: [issued.id],
      kind: "allow",
    });

    await auth.revoke({ grantId: issued.id, kind: "grant" }, "done");
    const after = await auth.verifyReceipt(receipt, REQUEST);
    expect(after.kind).toBe("deny");
  });

  it("pushes down action/state filters on hot paths", async () => {
    const inner = new MemoryAuthorizationStore();
    const grantQueries: unknown[] = [];
    const restrictionQueries: unknown[] = [];
    const spyingStore: AuthorizationStore = {
      commit: inner.commit.bind(inner),
      durability: inner.durability,
      getClaim: inner.getClaim.bind(inner),
      getGrant: inner.getGrant.bind(inner),
      getRestriction: inner.getRestriction.bind(inner),
      listGrants(query) {
        grantQueries.push(query);
        return inner.listGrants(query);
      },
      listRestrictions(query) {
        restrictionQueries.push(query);
        return inner.listRestrictions(query);
      },
    };
    const auth = new Authorization({ store: spyingStore });
    await auth.check(REQUEST);

    expect(grantQueries).toEqual([{ action: "tool.call", state: "active" }]);
    expect(restrictionQueries).toEqual([{ action: "tool.call" }]);
  });

  const databases = libsqlDatabases("memory");

  it.each(["memory", "sqlite"] as const)(
    "enforces expectedGrantRevisions, missing-grant CAS, createClaims, deleteGrants, and deleteClaims in %s store",
    async (kind) => {
      const store =
        kind === "sqlite"
          ? new SqliteAuthorizationStore({
              database: await databases.open(),
              scope: "cas-test",
            })
          : new MemoryAuthorizationStore();
      const auth = new Authorization({ clock: () => 1000, store });
      const issued = await auth.grant({
        holder: { kind: "exact", principal: AGENT },
        id: grantId("grt_cas_1"),
        requestedBy: USER,
        scope: {
          action: "tool.call",
          target: { kind: "exact", value: "deploy" },
        },
      });

      await expect(
        store.commit({
          expectedGrantRevisions: { [issued.id]: 99 },
          putGrants: [{ ...issued, revision: 100 }],
        })
      ).rejects.toBeInstanceOf(AuthorizationRevisionError);

      let missingError: unknown;
      try {
        await store.commit({
          expectedGrantRevisions: { [grantId("grt_missing")]: 0 },
        });
      } catch (error) {
        missingError = error;
      }
      expect(missingError).toBeInstanceOf(AuthorizationRevisionError);
      if (missingError instanceof AuthorizationRevisionError) {
        expect(missingError.expectedRevision).toBe(0);
        expect(missingError.actualRevision).toBeNull();
        expect(missingError.message).toContain("grant not found");
      }

      const claim = {
        claimedAt: 1000,
        grantId: issued.id,
        invocationId: "inv-cas-1",
      };
      await store.commit({ createClaims: [claim] });
      await expect(
        store.commit({ createClaims: [claim] })
      ).rejects.toBeInstanceOf(AuthorizationStateError);

      await store.commit({
        deleteClaims: ["inv-cas-1"],
        deleteGrants: [issued.id],
      });
      expect(await store.getClaim("inv-cas-1")).toBeNull();
      expect(await store.getGrant(issued.id)).toBeNull();
    }
  );

  it("aborts authorize() with AuthorizationRevisionError when a reusable grant or ancestor is concurrently revoked", async () => {
    const backing = new MemoryAuthorizationStore();
    const admin = new Authorization({ clock: () => 1000, store: backing });

    const reusableParent = await admin.grant({
      canDelegate: true,
      holder: { kind: "exact", principal: USER },
      requestedBy: USER,
      scope: { action: "tool.call", target: { kind: "any" } },
    });
    const reusableChild = await admin.grant({
      holder: { kind: "exact", principal: AGENT },
      parentIds: [reusableParent.id],
      requestedBy: USER,
      scope: {
        action: "tool.call",
        target: { kind: "exact", value: "deploy" },
      },
    });

    let revokeBeforeClaim: (() => Promise<void>) | undefined;
    const racingStore: AuthorizationStore = {
      async commit(write) {
        if ((write.createClaims?.length ?? 0) > 0 && revokeBeforeClaim) {
          const hook = revokeBeforeClaim;
          revokeBeforeClaim = undefined;
          await hook();
        }
        await backing.commit(write);
      },
      durability: backing.durability,
      getClaim: backing.getClaim.bind(backing),
      getGrant: backing.getGrant.bind(backing),
      getRestriction: backing.getRestriction.bind(backing),
      listGrants: backing.listGrants.bind(backing),
      listRestrictions: backing.listRestrictions.bind(backing),
    };
    const racingAuth = new Authorization({
      clock: () => 1000,
      store: racingStore,
    });

    // Concurrent revocation of reusable ancestor aborts the child claim
    revokeBeforeClaim = async () => {
      await admin.revoke(
        { grantId: reusableParent.id, kind: "grant" },
        "ancestor-revoked"
      );
    };
    await expect(
      racingAuth.authorize(REQUEST, "inv-race-ancestor")
    ).rejects.toBeInstanceOf(AuthorizationRevisionError);
    expect(await backing.getClaim("inv-race-ancestor")).toBeNull();

    // Concurrent revocation of direct reusable grant aborts the claim
    const directReusable = await admin.grant({
      holder: { kind: "exact", principal: AGENT },
      requestedBy: USER,
      scope: {
        action: "tool.call",
        target: { kind: "exact", value: "deploy" },
      },
    });
    expect(reusableChild.id).not.toBe(directReusable.id);

    revokeBeforeClaim = async () => {
      await admin.revoke(
        { grantId: directReusable.id, kind: "grant" },
        "direct-revoked"
      );
    };
    await expect(
      racingAuth.authorize(REQUEST, "inv-race-direct")
    ).rejects.toBeInstanceOf(AuthorizationRevisionError);
    expect(await backing.getClaim("inv-race-direct")).toBeNull();
  });

  it("rejects forged receipts, empty/mismatched grantPath, and reports deny and require-direct-grant restrictions in verifyReceipt()", async () => {
    const store = new MemoryAuthorizationStore();
    const auth = new Authorization({ clock: () => 1000, store });
    const issued = await auth.grant({
      holder: { kind: "match", principalKind: "agent" },
      requestedBy: USER,
      scope: {
        action: "tool.call",
        target: { kind: "exact", value: "deploy" },
      },
      usesRemaining: 1,
    });

    const outcome = await auth.authorize(REQUEST, "inv-real-1");
    expect(outcome.kind).toBe("permitted");
    if (outcome.kind !== "permitted") {
      return;
    }
    const { receipt } = outcome.permit;
    outcome.permit.release();

    // Fabricated receipt referencing the exhausted grant with a fake invocationId
    const forged = await auth.verifyReceipt(
      {
        grantId: issued.id,
        grantPath: [issued.id],
        invocationId: "fake",
        issuedAt: 1000,
      },
      REQUEST
    );
    expect(forged.kind).toBe("deny");

    // Valid invocationId but tampered request
    const tamperedRequest = await auth.verifyReceipt(receipt, {
      ...REQUEST,
      target: "other-target",
    });
    expect(tamperedRequest.kind).toBe("deny");

    // Empty grantPath must be rejected
    const emptyPath = await auth.verifyReceipt(
      { ...receipt, grantPath: [] },
      REQUEST
    );
    expect(emptyPath.kind).toBe("deny");

    // Valid invocationId and request, but tampered grantPath
    const tamperedPath = await auth.verifyReceipt(
      {
        ...receipt,
        grantPath: [issued.id, grantId("grt_bogus_parent")],
      },
      REQUEST
    );
    expect(tamperedPath.kind).toBe("deny");

    // Adding a require-direct-grant restriction invalidates a non-direct grant receipt with restrictionId
    const directReq = await auth.restrict({
      kind: "require-direct-grant",
      reason: "direct principal grant required",
      scope: {
        action: "tool.call",
        target: { kind: "exact", value: "deploy" },
      },
    });
    const blockedByDirect = await auth.verifyReceipt(receipt, REQUEST);
    expect(blockedByDirect).toEqual({
      kind: "deny",
      reason: "direct principal grant required",
      restrictionId: directReq.id,
    });

    // Adding a deny restriction invalidates the receipt and preserves restrictionId
    const deny = await auth.restrict({
      kind: "deny",
      reason: "frozen for maintenance",
      scope: {
        action: "tool.call",
        target: { kind: "exact", value: "deploy" },
      },
    });
    const blocked = await auth.verifyReceipt(receipt, REQUEST);
    expect(blocked).toEqual({
      kind: "deny",
      reason: "frozen for maintenance",
      restrictionId: deny.id,
    });
  });

  it("accepts legacy plaintext canonical JSON fingerprints during replay and verifyReceipt()", async () => {
    const store = new MemoryAuthorizationStore();
    const auth = new Authorization({ clock: () => 1000, store });
    const issued = await auth.grant({
      holder: { kind: "exact", principal: AGENT },
      requestedBy: USER,
      scope: {
        action: "tool.call",
        target: { kind: "exact", value: "deploy" },
      },
    });
    const legacyFingerprint = canonicalizeJson({
      action: REQUEST.action,
      attributes: REQUEST.attributes,
      constraintsDigest: null,
      principal: {
        attributes: null,
        id: REQUEST.principal.id,
        kind: REQUEST.principal.kind,
        version: null,
      },
      sessionId: null,
      target: REQUEST.target,
    });
    await store.commit({
      putClaims: [
        {
          claimedAt: 1000,
          grantId: issued.id,
          invocationId: "inv-legacy-1",
          requestFingerprint: legacyFingerprint,
        },
      ],
    });

    const replayed = await auth.authorize(REQUEST, "inv-legacy-1", {
      idempotent: true,
    });
    expect(replayed.kind).toBe("permitted");
    if (replayed.kind === "permitted") {
      expect(
        await auth.verifyReceipt(replayed.permit.receipt, REQUEST)
      ).toEqual({
        grantId: issued.id,
        grantPath: [issued.id],
        kind: "allow",
      });
      replayed.permit.release();
    }
  });
});
