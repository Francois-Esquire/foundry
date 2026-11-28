import { describe, expect, test } from "vitest";
import type { Grant, GrantId, InvocationClaim, Restriction } from "../schema";
import { grantId, restrictionId } from "../schema";
import type { AuthorizationStore } from "../store/index";

export type ScopedAuthorizationStores = (scope: string) => AuthorizationStore;

export interface AuthorizationStoreTestCapabilities {
  readonly insertionOrder?: boolean;
  readonly reentrancyGuard?: boolean;
  readonly transactions?: boolean;
}

export function describeAuthorizationStore(
  name: string,
  open: () => ScopedAuthorizationStores | Promise<ScopedAuthorizationStores>,
  capabilities: AuthorizationStoreTestCapabilities = {}
): void {
  const insertionOrder = capabilities.insertionOrder ?? true;
  const transactions = capabilities.transactions ?? true;
  const reentrancyGuard = capabilities.reentrancyGuard ?? transactions;
  async function store(scope = "scope-a"): Promise<AuthorizationStore> {
    return (await open())(scope);
  }

  describe(`${name} authorization store conformance`, () => {
    test("an empty store has no grants, restrictions, or claims", async () => {
      const empty = await store();
      expect(await empty.getGrant(grantId("missing"))).toBeNull();
      expect(await empty.getRestriction(restrictionId("missing"))).toBeNull();
      expect(await empty.getClaim("missing")).toBeNull();
      expect(await empty.listGrants()).toEqual([]);
      expect(await empty.listRestrictions()).toEqual([]);
    });

    test("a commit puts grants, restrictions, and claims, and reads return them whole", async () => {
      const target = await store();
      const first = sampleGrant("g-1", {
        issuanceKey: "iss-1",
        sessionId: "sess-1",
        usesRemaining: 2,
      });
      const second = sampleGrant("g-2", {
        invocationId: "inv-2",
        parentIds: [first.id],
        state: "pending",
      });
      const guardrail = sampleRestriction("r-1", { appliesUnder: first.id });
      const claim = sampleClaim("inv-1", first.id);

      await target.commit({
        putClaims: [claim],
        putGrants: [first, second],
        putRestrictions: [guardrail],
      });

      expect(await target.getGrant(first.id)).toEqual(first);
      expect(await target.getGrant(second.id)).toEqual(second);
      const listedGrants = await target.listGrants();
      if (insertionOrder) {
        expect(listedGrants).toEqual([first, second]);
      } else {
        expect(
          [...listedGrants].sort((a, b) => a.id.localeCompare(b.id))
        ).toEqual([first, second]);
      }
      expect(await target.getRestriction(guardrail.id)).toEqual(guardrail);
      expect(await target.listRestrictions()).toEqual([guardrail]);
      expect(await target.getClaim(claim.invocationId)).toEqual(claim);
    });

    test("listGrants filters by state, session, issuanceKey, invocationId, action, parentId, and principal", async () => {
      const target = await store();
      const root = sampleGrant("root", {
        issuanceKey: "batch-1",
        scope: { action: "fs.read", target: { kind: "any" } },
        sessionId: "sess-a",
        state: "active",
      });
      const child = sampleGrant("child", {
        holder: {
          kind: "exact",
          principal: { id: "worker-2", kind: "agent" },
        },
        invocationId: "inv-child",
        parentIds: [root.id],
        scope: { action: "shell.exec", target: { kind: "any" } },
        state: "pending",
      });
      await target.commit({ putGrants: [root, child] });

      expect(await target.listGrants({ state: "active" })).toEqual([root]);
      expect(
        await target.listGrants({ state: ["pending", "revoked"] })
      ).toEqual([child]);
      expect(await target.listGrants({ sessionId: "sess-a" })).toEqual([root]);
      expect(await target.listGrants({ issuanceKey: "batch-1" })).toEqual([
        root,
      ]);
      expect(await target.listGrants({ invocationId: "inv-child" })).toEqual([
        child,
      ]);
      expect(await target.listGrants({ action: "shell.exec" })).toEqual([
        child,
      ]);
      expect(await target.listGrants({ parentId: root.id })).toEqual([child]);
      expect(
        await target.listGrants({
          principal: { id: "worker-2", kind: "agent" },
        })
      ).toEqual([child]);
    });

    test.runIf(insertionOrder)(
      "reads preserve insertion order; updates keep position; restriction deletes apply before puts",
      async () => {
        const target = await store();
        const a = sampleGrant("a");
        const b = sampleGrant("b");
        const c = sampleGrant("c");
        await target.commit({ putGrants: [b] });
        await target.commit({ putGrants: [a, c] });

        const updatedB = { ...b, reason: "updated", revision: 2 };
        await target.commit({ putGrants: [updatedB] });
        expect(await target.listGrants()).toEqual([updatedB, a, c]);

        const r1 = sampleRestriction("r-1");
        const r2 = sampleRestriction("r-2");
        await target.commit({ putRestrictions: [r1, r2] });
        const recreatedR1 = { ...r1, reason: "recreated", revision: 2 };
        await target.commit({
          deleteRestrictions: [r1.id],
          putRestrictions: [recreatedR1],
        });
        expect(await target.listRestrictions()).toEqual([r2, recreatedR1]);
      }
    );

    test("deleteRestrictions removes only named restrictions and ignores missing keys", async () => {
      const target = await store();
      const r1 = sampleRestriction("r-1");
      const r2 = sampleRestriction("r-2");
      await target.commit({ putRestrictions: [r1, r2] });

      await target.commit({
        deleteRestrictions: [r1.id, restrictionId("missing")],
      });

      expect(await target.getRestriction(r1.id)).toBeNull();
      expect(await target.listRestrictions()).toEqual([r2]);
    });

    test("reads and writes are detached from caller mutations", async () => {
      const target = await store();
      const original = sampleGrant("detached");
      const written = structuredClone(original);
      await target.commit({ putGrants: [written] });
      (written as { reason?: string }).reason = "mutated-after-commit";

      const read = await target.getGrant(original.id);
      expect(read).toEqual(original);
      if (read !== null) {
        (read as { reason?: string }).reason = "mutated-after-read";
      }
      expect(await target.getGrant(original.id)).toEqual(original);
    });

    test("scopes on one storage are completely isolated", async () => {
      const stores = await open();
      const first = stores("scope-a");
      const second = stores("scope-b");
      const a = sampleGrant("shared", { reason: "in a" });
      const b = sampleGrant("shared", { reason: "in b" });

      await first.commit({
        putClaims: [sampleClaim("inv", a.id)],
        putGrants: [a],
        putRestrictions: [sampleRestriction("r", { reason: "in a" })],
      });

      expect(await second.getGrant(a.id)).toBeNull();
      expect(await second.listGrants()).toEqual([]);
      expect(await second.listRestrictions()).toEqual([]);
      expect(await second.getClaim("inv")).toBeNull();

      await second.commit({ putGrants: [b] });
      await second.commit({ deleteRestrictions: [restrictionId("r")] });

      expect(await first.getGrant(a.id)).toEqual(a);
      expect(await first.getRestriction(restrictionId("r"))).not.toBeNull();
    });

    test.runIf(transactions)(
      "transactions read their own writes and roll back completely on throw",
      async () => {
        const target = await store();
        const kept = sampleGrant("kept");
        const lost = sampleGrant("lost");
        const rKept = sampleRestriction("r-kept");
        await target.commit({ putGrants: [kept], putRestrictions: [rKept] });

        await expect(
          transactionOf(target)(async (view) => {
            await view.commit({
              deleteRestrictions: [rKept.id],
              putGrants: [lost],
            });
            expect(await view.getGrant(lost.id)).toEqual(lost);
            expect(await view.getRestriction(rKept.id)).toBeNull();
            throw new Error("abort transaction");
          })
        ).rejects.toThrow("abort transaction");

        expect(await target.getGrant(kept.id)).toEqual(kept);
        expect(await target.getGrant(lost.id)).toBeNull();
        expect(await target.getRestriction(rKept.id)).toEqual(rKept);

        const returned = await transactionOf(target)(async (view) => {
          await view.commit({ putGrants: [lost] });
          return "committed";
        });
        expect(returned).toBe("committed");
        expect(await target.getGrant(lost.id)).toEqual(lost);
      }
    );

    test.runIf(transactions && reentrancyGuard)(
      "reentrant calls to the outer store inside a transaction are rejected",
      async () => {
        const target = await store();
        const g = sampleGrant("g");
        const outcomes = await transactionOf(target)(async (view) => {
          const results = await Promise.all([
            settlesWithin(target.getGrant(g.id), 1000),
            settlesWithin(target.listGrants(), 1000),
            settlesWithin(target.commit({ putGrants: [g] }), 1000),
            settlesWithin(
              transactionOf(target)(() => Promise.resolve()),
              1000
            ),
          ]);
          await view.commit({ putGrants: [g] });
          return results;
        });
        for (const outcome of outcomes) {
          expect(outcome).toMatch(REFUSAL);
        }
        expect(await target.getGrant(g.id)).toEqual(g);
      }
    );
  });
}

const REFUSAL = /refused: .*use the view/;

function transactionOf(
  store: AuthorizationStore
): NonNullable<AuthorizationStore["transaction"]> {
  const { transaction } = store;
  if (transaction === undefined) {
    throw new Error("store does not implement transaction()");
  }
  return transaction.bind(store);
}

async function settlesWithin(
  promise: Promise<unknown>,
  ms: number
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("still pending"), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => "resolved",
        (error: unknown) =>
          `refused: ${error instanceof Error ? error.message : String(error)}`
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sampleGrant(id: string, overrides: Partial<Grant> = {}): Grant {
  return {
    approvals: [],
    canDelegate: false,
    createdAt: 1_700_000_000_000,
    holder: { kind: "exact", principal: { id: "agent-1", kind: "agent" } },
    id: grantId(id),
    parentIds: [],
    requestedBy: { id: "agent-1", kind: "agent" },
    requiredApprovals: 1,
    revision: 1,
    scope: { action: "tool.call", target: { kind: "exact", value: "bash" } },
    state: "active",
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function sampleRestriction(
  id: string,
  overrides: Partial<Restriction> = {}
): Restriction {
  return {
    createdAt: 1_700_000_000_000,
    id: restrictionId(id),
    kind: "deny",
    reason: "blocked by policy",
    revision: 1,
    scope: { action: "tool.call", target: { kind: "exact", value: "rm" } },
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function sampleClaim(
  invocationId: string,
  targetGrantId: GrantId
): InvocationClaim {
  return {
    claimedAt: 1_700_000_000_000,
    grantId: targetGrantId,
    invocationId,
    requestFingerprint: '{"action":"tool.call","target":"bash"}',
  };
}
