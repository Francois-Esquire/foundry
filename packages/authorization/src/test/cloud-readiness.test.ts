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

describe("Authorization cloud-readiness fixes", () => {
  it("hashes requestFingerprint with SHA-256, strips nested undefined, supports legacy plaintext replay, and uses injectable generateId", async () => {
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
    });
    expect(issued.id).toBe("grt_custom_1");

    const nested: AccessRequest = {
      ...REQUEST,
      attributes: {
        apiKey: "super-secret-token",
        nested: { a: 1, drop: undefined },
      } as unknown as AccessRequest["attributes"],
    };
    const outcome = await auth.authorize(nested, "inv-hash-1");
    expect(outcome.kind).toBe("permitted");
    if (outcome.kind === "permitted") {
      outcome.permit.release();
    }

    const claim = await store.getClaim("inv-hash-1");
    expect(claim?.requestFingerprint).toMatch(SHA256_HEX);
    expect(claim?.requestFingerprint).not.toContain("super-secret-token");

    const equivalent: AccessRequest = {
      ...REQUEST,
      attributes: { apiKey: "super-secret-token", nested: { a: 1 } },
    };
    const replayed = await auth.authorize(equivalent, "inv-hash-1", {
      idempotent: true,
    });
    expect(replayed.kind).toBe("permitted");
    if (replayed.kind === "permitted") {
      replayed.permit.release();
    }

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
    const legacyReplay = await auth.authorize(REQUEST, "inv-legacy-1", {
      idempotent: true,
    });
    expect(legacyReplay.kind).toBe("permitted");
    if (legacyReplay.kind === "permitted") {
      legacyReplay.permit.release();
    }

    const deny = await auth.restrict({
      kind: "deny",
      reason: "frozen",
      scope: {
        action: "tool.call",
        target: { kind: "exact", value: "deploy" },
      },
    });
    const blocked = await auth.authorize(REQUEST, "inv-legacy-1", {
      idempotent: true,
    });
    expect(blocked).toEqual({
      kind: "denied",
      reason: "frozen",
      restrictionId: deny.id,
    });
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
      listGrants: (q) => {
        grantQueries.push(q);
        return inner.listGrants(q);
      },
      listRestrictions: (q) => {
        restrictionQueries.push(q);
        return inner.listRestrictions(q);
      },
    };
    const auth = new Authorization({ store: spyingStore });
    await auth.check(REQUEST);
    expect(grantQueries).toEqual([{ action: "tool.call", state: "active" }]);
    expect(restrictionQueries).toEqual([{ action: "tool.call" }]);
  });

  const databases = libsqlDatabases("memory");

  it.each(["memory", "sqlite"] as const)(
    "enforces expectedGrantRevisions (incl. missing grant) and insert-only createClaims in %s store",
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

      await expect(
        store.commit({
          expectedGrantRevisions: { [grantId("grt_missing")]: 0 },
        })
      ).rejects.toMatchObject({ actualRevision: null, expectedRevision: 0 });

      const claim = {
        claimedAt: 1000,
        grantId: issued.id,
        invocationId: "inv-1",
      };
      await store.commit({ createClaims: [claim] });
      await expect(
        store.commit({ createClaims: [claim] })
      ).rejects.toBeInstanceOf(AuthorizationStateError);
    }
  );

  it("aborts authorize() when a reusable ancestor grant is concurrently revoked", async () => {
    const backing = new MemoryAuthorizationStore();
    const admin = new Authorization({ clock: () => 1000, store: backing });
    const parent = await admin.grant({
      canDelegate: true,
      holder: { kind: "exact", principal: USER },
      requestedBy: USER,
      scope: { action: "tool.call", target: { kind: "any" } },
    });
    await admin.grant({
      holder: { kind: "exact", principal: AGENT },
      parentIds: [parent.id],
      requestedBy: USER,
      scope: {
        action: "tool.call",
        target: { kind: "exact", value: "deploy" },
      },
    });

    let raced = false;
    const racingStore: AuthorizationStore = {
      async commit(write) {
        if (!raced && (write.createClaims?.length ?? 0) > 0) {
          raced = true;
          await admin.revoke({ grantId: parent.id, kind: "grant" }, "revoked");
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
    await expect(
      racingAuth.authorize(REQUEST, "inv-race")
    ).rejects.toBeInstanceOf(AuthorizationRevisionError);
    expect(await backing.getClaim("inv-race")).toBeNull();
  });
});
