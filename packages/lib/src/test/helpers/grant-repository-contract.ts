/**
 * The GrantRepository contract, as one suite any adapter runs. The in-memory
 * reference adapter defines the semantics; a durable adapter is correct when
 * it passes the same suite.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type {
  AuthorizationSubject,
  GrantRepository,
} from "../../config/authorization";
import {
  GrantClaimError,
  GrantRevisionError,
} from "../../config/authorization";
import type { TestCapability } from "./authorization-support";
import {
  fsRead,
  preset,
  testAddressing,
  testClock,
} from "./authorization-support";

export type TestGrantRepository = GrantRepository<
  AuthorizationSubject,
  TestCapability
>;

const addressing = testAddressing();
const ADDRESS = addressing.addressOf(preset("chat", 3), fsRead("/p"));
const OTHER = addressing.addressOf(preset("canvas", 1), fsRead("/p"));

export function grantRepositoryContract(
  name: string,
  create: (now: () => number) => Promise<TestGrantRepository>
): void {
  describe(name, () => {
    let clock: ReturnType<typeof testClock>;
    let grants: TestGrantRepository;

    beforeEach(async () => {
      clock = testClock();
      grants = await create(clock.now);
    });

    it("starts with no authority at any address", async () => {
      await expect(grants.find(ADDRESS, clock.now())).resolves.toEqual([]);
    });

    it("finds only the authority issued at that exact address", async () => {
      await grants.issue({
        address: ADDRESS,
        capability: fsRead("/p"),
        lifetime: { kind: "persistent" },
        provenance: "human",
      });

      await expect(grants.find(ADDRESS, clock.now())).resolves.toHaveLength(1);
      await expect(grants.find(OTHER, clock.now())).resolves.toEqual([]);
    });

    it("returns every live grant at one address", async () => {
      for (const provenance of ["human", "certificate"] as const) {
        await grants.issue({
          address: ADDRESS,
          capability: fsRead("/p"),
          lifetime: { kind: "persistent" },
          provenance,
        });
      }

      await expect(grants.find(ADDRESS, clock.now())).resolves.toHaveLength(2);
    });

    describe("expiry", () => {
      it("stops finding a grant once its expiry has passed", async () => {
        await grants.issue({
          address: ADDRESS,
          capability: fsRead("/p"),
          expiresAt: 2000,
          lifetime: { kind: "persistent" },
          provenance: "human",
        });

        await expect(grants.find(ADDRESS, 1999)).resolves.toHaveLength(1);
        await expect(grants.find(ADDRESS, 2000)).resolves.toEqual([]);
        await expect(grants.find(ADDRESS, 2001)).resolves.toEqual([]);
      });
    });

    describe("revocation", () => {
      it("removes the grant from later lookups", async () => {
        const grant = await grants.issue({
          address: ADDRESS,
          capability: fsRead("/p"),
          lifetime: { kind: "persistent" },
          provenance: "human",
        });

        await grants.revoke(grant.id);
        await expect(grants.find(ADDRESS, clock.now())).resolves.toEqual([]);
      });

      it("succeeds for authority that is already gone", async () => {
        const grant = await grants.issue({
          address: ADDRESS,
          capability: fsRead("/p"),
          lifetime: { kind: "persistent" },
          provenance: "human",
        });

        await grants.revoke(grant.id);
        await expect(grants.revoke(grant.id)).resolves.toBeUndefined();
        await expect(
          grants.revoke("grant_nonexistent")
        ).resolves.toBeUndefined();
      });

      it("rejects a revision that is no longer current", async () => {
        const grant = await grants.issue({
          address: ADDRESS,
          capability: fsRead("/p"),
          lifetime: { kind: "once" },
          provenance: "human",
        });

        // Claiming a one-shot grant moves it on, so the caller's earlier
        // revision no longer describes it.
        await grants.claimOnce(grant.id, "invocation-1");
        const stale = grants.revoke(grant.id, grant.revision);
        await expect(stale).rejects.toBeInstanceOf(GrantRevisionError);
      });

      it("accepts the current revision", async () => {
        const grant = await grants.issue({
          address: ADDRESS,
          capability: fsRead("/p"),
          lifetime: { kind: "persistent" },
          provenance: "human",
        });

        await expect(
          grants.revoke(grant.id, grant.revision)
        ).resolves.toBeUndefined();
      });
    });

    /**
     * The sharpest risk in the consolidation. A one-shot grant is consumed by
     * being taken, and the agent path evaluates every tool call more than once —
     * so taking authority has to be idempotent by invocation, or a replay spends
     * a grant the real call then cannot use.
     */
    describe("claiming one-shot authority", () => {
      it("consumes the grant, so it is no longer live", async () => {
        const grant = await grants.issue({
          address: ADDRESS,
          capability: fsRead("/p"),
          lifetime: { kind: "once" },
          provenance: "human",
        });

        await grants.claimOnce(grant.id, "invocation-1");
        await expect(grants.find(ADDRESS, clock.now())).resolves.toEqual([]);
      });

      it("lets the same invocation replay and observe its existing claim", async () => {
        const grant = await grants.issue({
          address: ADDRESS,
          capability: fsRead("/p"),
          lifetime: { kind: "once" },
          provenance: "human",
        });

        const first = await grants.claimOnce(grant.id, "invocation-1");
        const replay = await grants.claimOnce(grant.id, "invocation-1");

        expect(replay).toEqual(first);
        expect(replay.invocationId).toBe("invocation-1");
      });

      it("refuses a different invocation the authority already spent", async () => {
        const grant = await grants.issue({
          address: ADDRESS,
          capability: fsRead("/p"),
          lifetime: { kind: "once" },
          provenance: "human",
        });

        await grants.claimOnce(grant.id, "invocation-1");
        await expect(
          grants.claimOnce(grant.id, "invocation-2")
        ).rejects.toBeInstanceOf(GrantClaimError);
      });

      it("does not consume authority that is not one-shot", async () => {
        for (const lifetime of [
          { kind: "persistent" },
          { kind: "session", scopeId: "session-1" },
        ] as const) {
          const grant = await grants.issue({
            address: ADDRESS,
            capability: fsRead("/p"),
            lifetime,
            provenance: "human",
          });

          await grants.claimOnce(grant.id, "invocation-1");
          await grants.claimOnce(grant.id, "invocation-2");

          const live = await grants.find(ADDRESS, clock.now());
          expect(live.map((found) => found.id)).toContain(grant.id);
          await grants.revoke(grant.id);
        }
      });

      it("refuses a grant that does not exist", async () => {
        await expect(
          grants.claimOnce("grant_nonexistent", "invocation-1")
        ).rejects.toBeInstanceOf(GrantClaimError);
      });

      it("refuses a grant revoked before the effect boundary was reached", async () => {
        const grant = await grants.issue({
          address: ADDRESS,
          capability: fsRead("/p"),
          lifetime: { kind: "once" },
          provenance: "human",
        });

        await grants.revoke(grant.id);
        await expect(
          grants.claimOnce(grant.id, "invocation-1")
        ).rejects.toBeInstanceOf(GrantClaimError);
      });

      it("refuses a grant that expired before the effect boundary was reached", async () => {
        const grant = await grants.issue({
          address: ADDRESS,
          capability: fsRead("/p"),
          expiresAt: 1500,
          lifetime: { kind: "once" },
          provenance: "human",
        });

        clock.advance(1000);
        await expect(
          grants.claimOnce(grant.id, "invocation-1")
        ).rejects.toBeInstanceOf(GrantClaimError);
      });

      it("still replays a spent claim after the grant expires or is revoked", async () => {
        const grant = await grants.issue({
          address: ADDRESS,
          capability: fsRead("/p"),
          expiresAt: 1500,
          lifetime: { kind: "once" },
          provenance: "human",
        });
        const claim = await grants.claimOnce(grant.id, "invocation-1");

        clock.advance(1000);
        await expect(
          grants.claimOnce(grant.id, "invocation-1")
        ).resolves.toEqual(claim);
        await grants.revoke(grant.id, claim.revision);
        await expect(
          grants.claimOnce(grant.id, "invocation-1")
        ).resolves.toEqual(claim);
        await expect(
          grants.claimOnce(grant.id, "invocation-2")
        ).rejects.toBeInstanceOf(GrantClaimError);
      });
    });

    describe("the issued record", () => {
      it("numbers grants in issue order", async () => {
        const issued: string[] = [];
        for (const lifetime of [
          { kind: "once" },
          { kind: "persistent" },
        ] as const) {
          const grant = await grants.issue({
            address: ADDRESS,
            capability: fsRead("/p"),
            lifetime,
            provenance: "human",
          });
          issued.push(grant.id);
        }

        expect(issued).toEqual(["grant_1", "grant_2"]);
      });

      it("carries lifetime and provenance as separate facts", async () => {
        const grant = await grants.issue({
          address: ADDRESS,
          capability: fsRead("/p"),
          certificateId: "cert-1",
          lifetime: { kind: "session", scopeId: "session-1" },
          provenance: "certificate",
        });

        expect(grant.lifetime).toEqual({
          kind: "session",
          scopeId: "session-1",
        });
        expect(grant.provenance).toBe("certificate");
        expect(grant.certificateId).toBe("cert-1");
        expect(grant.issuedAt).toBe(1000);
      });

      it("keeps the host capability alongside the address", async () => {
        const grant = await grants.issue({
          address: ADDRESS,
          capability: fsRead("/p"),
          lifetime: { kind: "persistent" },
          provenance: "human",
        });

        expect(grant.capability).toEqual({ kind: "fs.read", root: "/p" });
        expect(grant.address).toEqual(ADDRESS);
      });
    });
  });
}
