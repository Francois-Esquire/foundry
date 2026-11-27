import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { type CommitEffects, runAfterCommit } from "@foundry/core/storage";
import {
  type ChildScript,
  startScript,
} from "@foundry/lib/testing/child-script";
import { describe, expect, test } from "vitest";
import {
  Authorization,
  AuthorizationStateError,
  type Principal,
  restrictionId,
} from "../index";
import { SqliteAuthorizationStore } from "../store/sqlite";
import { libsqlDatabases } from "./helpers/sqlite";

const files = libsqlDatabases("file");

const HOST: Principal = { id: "host", kind: "host" };
const AGENT: Principal = { id: "agent-1", kind: "agent" };

describe("SqliteAuthorizationStore cross-process exclusion and host transaction safety", () => {
  test("prevents double-claiming a one-shot grant across concurrent processes", async () => {
    const database = files.connect(await files.open(), { busyTimeout: 5000 });
    const store = new SqliteAuthorizationStore({ database, scope: "s" });
    const auth = new Authorization({ store });

    const oneShot = await auth.grant({
      holder: { kind: "exact", principal: AGENT },
      requestedBy: HOST,
      scope: {
        action: "payment.send",
        target: { kind: "exact", value: "tx-1" },
      },
      usesRemaining: 1,
    });

    const req = {
      action: "payment.send",
      principal: AGENT,
      target: "tx-1",
    };

    let racer: ChildScript | undefined;
    try {
      racer = await startScript(CLAIM_RACER, [
        pathToFileURL(createRequire(import.meta.url).resolve("@libsql/client"))
          .href,
        `file:${files.path(database)}`,
        oneShot.id,
      ]);
      expect(await racer.line()).toBe("locked");

      const parentOutcome = await auth.authorize(req, "inv-parent", {
        openPending: false,
      });
      const childResult = await racer.line();
      await racer.exited();

      expect(childResult).toBe("claimed");
      expect(parentOutcome.kind).toBe("denied");

      const finalGrant = await auth.getGrant(oneShot.id);
      expect(finalGrant?.state).toBe("exhausted");
      expect(finalGrant?.usesRemaining).toBe(0);
      expect(await store.getClaim("inv-child")).not.toBeNull();
      expect(await store.getClaim("inv-parent")).toBeNull();
    } finally {
      await racer?.stop();
    }
  }, 20_000);

  test("requires CommitEffects on host-owned SQLite transactions, blocks host-durable authorize, and never fires revocation on rollback", async () => {
    const database = await files.open();
    const rootStore = new SqliteAuthorizationStore({ database, scope: "s" });
    const rootAuth = new Authorization({ store: rootStore });

    const grant = await rootAuth.grant({
      holder: { kind: "exact", principal: AGENT },
      requestedBy: HOST,
      scope: { action: "file.read", target: { kind: "any" } },
    });

    const live = await rootAuth.authorize(
      { action: "file.read", principal: AGENT, target: "/a" },
      "inv-live"
    );
    expect(live.kind).toBe("permitted");
    if (live.kind !== "permitted") {
      throw new Error("expected permitted");
    }

    await database.transaction(async (tx) => {
      const txStore = new SqliteAuthorizationStore({
        database: tx,
        scope: "s",
      });
      expect(txStore.durability).toBe("host");
      expect(
        () =>
          new SqliteAuthorizationStore({
            database: tx,
            durability: "commit",
            scope: "s",
          })
      ).toThrow(RangeError);
      const txAuth = new Authorization({ store: txStore });
      await expect(
        txAuth.revoke({ grantId: grant.id, kind: "grant" })
      ).rejects.toThrow(TypeError);
      expect((await txStore.getGrant(grant.id))?.state).toBe("active");

      const hostCallbacks: (() => Promise<void>)[] = [];
      const hostEffects: CommitEffects = {
        afterCommit(operation) {
          hostCallbacks.push(operation);
        },
      };
      const boundAuth = rootAuth.within(txStore, hostEffects);
      await expect(
        boundAuth.authorize(
          { action: "file.read", principal: AGENT, target: "/b" },
          "inv-host-blocked"
        )
      ).rejects.toBeInstanceOf(AuthorizationStateError);
      expect(hostCallbacks).toEqual([]);
      expect(await txStore.getClaim("inv-host-blocked")).toBeNull();
    });

    const rollbackCallbacks: (() => Promise<void>)[] = [];
    const rollbackEffects: CommitEffects = {
      afterCommit(operation) {
        rollbackCallbacks.push(operation);
      },
    };
    const seenEvents: string[] = [];
    const unwatch = rootAuth.watch((event) => {
      seenEvents.push(event.type);
    });

    await expect(
      database.transaction(async (tx) => {
        const txStore = new SqliteAuthorizationStore({
          database: tx,
          scope: "s",
        });
        const txAuth = rootAuth.within(txStore, rollbackEffects);
        await txAuth.revoke(
          { grantId: grant.id, kind: "grant" },
          { reason: "rolled back" }
        );
        throw new Error("host rollback");
      })
    ).rejects.toThrow("host rollback");

    expect(seenEvents).toEqual([]);
    expect(rollbackCallbacks).toHaveLength(1);
    expect(live.permit.signal.aborted).toBe(false);
    expect((await rootAuth.getGrant(grant.id))?.state).toBe("active");

    const commitCallbacks: (() => Promise<void>)[] = [];
    const commitEffects: CommitEffects = {
      afterCommit(operation) {
        commitCallbacks.push(operation);
      },
    };
    await database.transaction(async (tx) => {
      const txStore = new SqliteAuthorizationStore({
        database: tx,
        scope: "s",
      });
      const txAuth = rootAuth.within(txStore, commitEffects);
      await txAuth.revoke(
        { grantId: grant.id, kind: "grant" },
        { reason: "committed revoke" }
      );
      expect(live.permit.signal.aborted).toBe(false);
    });
    await runAfterCommit(commitCallbacks);

    expect(live.permit.signal.aborted).toBe(true);
    expect(seenEvents).toEqual(["grant.revoked"]);
    expect((await rootAuth.getGrant(grant.id))?.state).toBe("revoked");
    live.permit.release();
    unwatch();
  });

  test("serializes savepoints across multiple SqliteAuthorizationStore instances sharing one host transaction", async () => {
    const database = await files.open();
    const keepId = restrictionId("rst-keep");
    const droppedId = restrictionId("rst-dropped");

    await database.transaction(async (tx) => {
      const storeA = new SqliteAuthorizationStore({ database: tx, scope: "s" });
      const storeB = new SqliteAuthorizationStore({ database: tx, scope: "s" });

      const [resultA, resultB] = await Promise.allSettled([
        storeA.transaction(async (viewA) => {
          await viewA.commit({
            putRestrictions: [
              {
                createdAt: 1,
                id: droppedId,
                kind: "deny",
                reason: "rolled back",
                revision: 1,
                scope: { action: "a", target: { kind: "any" } },
                updatedAt: 1,
              },
            ],
          });
          await new Promise((resolve) => setTimeout(resolve, 25));
          throw new Error("savepoint A failed");
        }),
        storeB.commit({
          putRestrictions: [
            {
              createdAt: 1,
              id: keepId,
              kind: "deny",
              reason: "must survive",
              revision: 1,
              scope: { action: "b", target: { kind: "any" } },
              updatedAt: 1,
            },
          ],
        }),
      ]);

      expect(resultA.status).toBe("rejected");
      expect(resultB.status).toBe("fulfilled");
    });

    const verifyStore = new SqliteAuthorizationStore({ database, scope: "s" });
    expect(await verifyStore.getRestriction(droppedId)).toBeNull();
    expect((await verifyStore.getRestriction(keepId))?.reason).toBe(
      "must survive"
    );
  });
});

const CLAIM_RACER = `const [clientPath, url, grantId] = process.argv.slice(2);
const { createClient } = await import(clientPath);
const db = createClient({ url, timeout: 10000 });
const tx = await db.transaction("write");
console.log("locked");
await new Promise((resolve) => setTimeout(resolve, 150));
const result = await tx.execute({
  sql: "SELECT state, record FROM authorization_grants WHERE scope = 's' AND id = ?",
  args: [grantId],
});
const row = result.rows[0];
const grant = JSON.parse(String(row.record));
if (row.state === "active" && grant.usesRemaining > 0) {
  const remaining = grant.usesRemaining - 1;
  grant.usesRemaining = remaining;
  grant.state = remaining === 0 ? "exhausted" : "active";
  grant.revision += 1;
  await tx.execute({
    sql: "UPDATE authorization_grants SET state = ?, revision = ?, record = ? WHERE scope = 's' AND id = ?",
    args: [grant.state, grant.revision, JSON.stringify(grant), grantId],
  });
  await tx.execute({
    sql: "INSERT INTO authorization_claims (scope, invocation_id, grant_id, claimed_at) VALUES ('s', 'inv-child', ?, 1)",
    args: [grantId],
  });
  await tx.commit();
  console.log("claimed");
} else {
  await tx.commit();
  console.log("exhausted");
}
db.close();
`;
