import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { type CommitEffects, runAfterCommit } from "@foundry/core/storage";
import {
  type ChildScript,
  startScript,
} from "@foundry/lib/testing/child-script";
import { describe, expect, test } from "vitest";
import { Authorization, type Principal } from "../index";
import { SqliteAuthorizationStore } from "../store/sqlite";
import { libsqlDatabases } from "./helpers/sqlite";

const LOCKED = /locked|busy/i;
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
      const parentOutcome = await store.transaction(async (view) => {
        const boundCallbacks: (() => Promise<void>)[] = [];
        const effects: CommitEffects = {
          afterCommit(callback) {
            boundCallbacks.push(callback);
          },
        };
        const boundAuth = new Authorization({ store: view });
        racer = await startScript(CLAIM_RACER, [
          pathToFileURL(
            createRequire(import.meta.url).resolve("@libsql/client")
          ).href,
          `file:${files.path(database)}`,
          oneShot.id,
        ]);
        const probe = await racer.line();
        const outcome = await boundAuth.authorize(req, "inv-parent", {
          effects,
          openPending: false,
        });
        return { boundCallbacks, outcome, probe };
      });

      await runAfterCommit(parentOutcome.boundCallbacks);
      expect(parentOutcome.probe).toMatch(LOCKED);
      expect(parentOutcome.outcome.kind).toBe("permitted");
      if (parentOutcome.outcome.kind === "permitted") {
        parentOutcome.outcome.permit.release();
      }

      const childResult = await racer?.line();
      await racer?.exited();
      expect(childResult).toBe("exhausted");

      const finalGrant = await auth.getGrant(oneShot.id);
      expect(finalGrant?.state).toBe("exhausted");
      expect(finalGrant?.usesRemaining).toBe(0);
      expect(await store.getClaim("inv-parent")).not.toBeNull();
      expect(await store.getClaim("inv-child")).toBeNull();
    } finally {
      await racer?.stop();
    }
  });

  test("requires CommitEffects on host-owned SQLite transactions and never fires revocation on rollback", async () => {
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

    await expect(
      database.transaction(async (tx) => {
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
        await txAuth.revoke({ grantId: grant.id, kind: "grant" });
      })
    ).rejects.toThrow(TypeError);

    const pendingEffects: (() => Promise<void>)[] = [];
    const effects: CommitEffects = {
      afterCommit(operation) {
        pendingEffects.push(operation);
      },
    };
    const seenEvents: string[] = [];

    await expect(
      database.transaction(async (tx) => {
        const txStore = new SqliteAuthorizationStore({
          database: tx,
          scope: "s",
        });
        const txAuth = new Authorization({ store: txStore });
        txAuth.watch((event) => {
          seenEvents.push(event.type);
        });
        await txAuth.revoke(
          { grantId: grant.id, kind: "grant" },
          { effects, reason: "rolled back" }
        );
        throw new Error("host rollback");
      })
    ).rejects.toThrow("host rollback");

    expect(seenEvents).toEqual([]);
    expect(pendingEffects).toHaveLength(1);
    expect(live.permit.signal.aborted).toBe(false);
    expect((await rootAuth.getGrant(grant.id))?.state).toBe("active");
    live.permit.release();
  });
});

const CLAIM_RACER = `const [clientPath, url, grantId] = process.argv.slice(2);
const { createClient } = await import(clientPath);
const probe = createClient({ url });
try {
  const attempt = await probe.transaction("write");
  await attempt.rollback();
  console.log("free");
} catch (error) {
  console.log(String(error));
} finally {
  probe.close();
}
const db = createClient({ url, timeout: 10000 });
const tx = await db.transaction("write");
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
    sql: "INSERT INTO authorization_claims (scope, invocation_id, grant_id, claimed_at, released_at) VALUES ('s', 'inv-child', ?, 1, NULL)",
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
