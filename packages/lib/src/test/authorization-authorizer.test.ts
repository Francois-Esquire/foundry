import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AuthorizationEvent,
  AuthorizationPolicy,
  AuthorizationRequest,
  AuthorizationSubject,
  Authorizer,
  GrantRepository,
} from "../config/authorization";
import {
  createAuthorizer,
  createInMemoryGrantRepository,
} from "../config/authorization";
import type {
  TestCapability,
  TestCapabilityKind,
} from "./helpers/authorization-support";
import {
  fsRead,
  kindOf,
  preset,
  testAddressing,
  testClock,
  toolCall,
} from "./helpers/authorization-support";

type TestPolicy = AuthorizationPolicy<
  AuthorizationSubject,
  TestCapability,
  TestCapabilityKind
>;

type TestEvent = AuthorizationEvent<AuthorizationSubject, TestCapability>;

const addressing = testAddressing();
const SUBJECT = preset("chat", 3);

describe("the authorizer", () => {
  let clock: ReturnType<typeof testClock>;
  let grants: GrantRepository<AuthorizationSubject, TestCapability>;

  function authorizer(
    policy: TestPolicy
  ): Authorizer<AuthorizationSubject, TestCapability> {
    return createAuthorizer({
      addressing,
      grants,
      kindOf,
      now: clock.now,
      policy,
    });
  }

  function request(
    capability: TestCapability,
    overrides: Partial<
      AuthorizationRequest<AuthorizationSubject, TestCapability>
    > = {}
  ): AuthorizationRequest<AuthorizationSubject, TestCapability> {
    return {
      capability,
      invocationId: "invocation-1",
      subject: SUBJECT,
      ...overrides,
    };
  }

  function grant(
    capability: TestCapability,
    lifetime: Parameters<typeof grants.issue>[0]["lifetime"],
    subject: AuthorizationSubject = SUBJECT
  ) {
    return grants.issue({
      address: addressing.addressOf(subject, capability),
      capability,
      lifetime,
      provenance: "human",
    });
  }

  beforeEach(() => {
    clock = testClock();
    grants = createInMemoryGrantRepository({ now: clock.now });
  });

  describe("precedence", () => {
    it("denies an exact rule ahead of everything else", async () => {
      await grant(fsRead("/p"), { kind: "persistent" });
      const decision = await authorizer({
        exactDenies: [
          {
            capability: fsRead("/p"),
            reason: "That path is off limits.",
            subject: SUBJECT,
          },
        ],
        global: "allow",
      }).decide(request(fsRead("/p")));

      expect(decision).toEqual({
        kind: "deny",
        reason: "That path is off limits.",
        source: "policy",
      });
    });

    it("scopes an exact deny to the subject and capability it names", async () => {
      const policy: TestPolicy = {
        exactDenies: [
          {
            capability: fsRead("/p"),
            reason: "That path is off limits.",
            subject: SUBJECT,
          },
        ],
        global: "allow",
      };

      // A different path and a different preset are untouched by the rule.
      await expect(
        authorizer(policy).decide(request(fsRead("/other")))
      ).resolves.toMatchObject({ kind: "allow" });
      await expect(
        authorizer(policy).decide(
          request(fsRead("/p"), { subject: preset("canvas", 1) })
        )
      ).resolves.toMatchObject({ kind: "allow" });
    });

    it("allows from a live grant ahead of a kind that would otherwise ask", async () => {
      const issued = await grant(fsRead("/p"), { kind: "persistent" });
      const decision = await authorizer({
        byKind: { "fs.read": "ask" },
        global: "deny",
      }).decide(request(fsRead("/p")));

      expect(decision).toEqual({
        grantId: issued.id,
        grantRevision: issued.revision,
        kind: "allow",
        source: "grant",
      });
    });

    it("falls to the capability kind's mode when no authority exists", async () => {
      const policy: TestPolicy = {
        byKind: { "fs.read": "ask", "tool.call": "allow" },
        global: "deny",
      };

      await expect(
        authorizer(policy).decide(request(fsRead("/p")))
      ).resolves.toEqual({ kind: "requires-approval" });
      await expect(
        authorizer(policy).decide(request(toolCall("web_fetch")))
      ).resolves.toEqual({ kind: "allow", source: "kind-policy" });
    });

    it("falls to the global mode when the kind has no override", async () => {
      await expect(
        authorizer({ global: "ask" }).decide(request(fsRead("/p")))
      ).resolves.toEqual({ kind: "requires-approval" });
      await expect(
        authorizer({ global: "allow" }).decide(request(fsRead("/p")))
      ).resolves.toEqual({ kind: "allow", source: "global-policy" });
      await expect(
        authorizer({ global: "deny" }).decide(request(fsRead("/p")))
      ).resolves.toMatchObject({ kind: "deny", source: "policy" });
    });

    it("keeps a deny-by-default posture expressible as the global mode", async () => {
      await expect(
        authorizer({ global: "deny" }).decide(request(toolCall("anything")))
      ).resolves.toMatchObject({ kind: "deny" });
    });
  });

  describe("fail-closed kinds", () => {
    it("denies rather than inheriting a blanket allow", async () => {
      const decision = await authorizer({
        failClosed: ["tool.call"],
        global: "allow",
      }).decide(request(toolCall("web_fetch")));

      expect(decision).toMatchObject({ kind: "deny", source: "policy" });
    });

    it("still honours an explicit kind override — the sanctioned escape hatch", async () => {
      const decision = await authorizer({
        byKind: { "tool.call": "ask" },
        failClosed: ["tool.call"],
        global: "allow",
      }).decide(request(toolCall("web_fetch")));

      expect(decision).toEqual({ kind: "requires-approval" });
    });

    it("still honours an exact grant", async () => {
      await grant(toolCall("web_fetch"), { kind: "persistent" });
      const decision = await authorizer({
        failClosed: ["tool.call"],
        global: "allow",
      }).decide(request(toolCall("web_fetch")));

      expect(decision).toMatchObject({ kind: "allow", source: "grant" });
    });

    it("explains itself with the host's reason when one is supplied", async () => {
      const decision = await createAuthorizer({
        addressing,
        failClosedReason: (capability) =>
          `No classification for ${capability.kind}.`,
        grants,
        kindOf,
        now: clock.now,
        policy: { failClosed: ["tool.call"], global: "allow" },
      }).decide(request(toolCall("web_fetch")));

      expect(decision).toMatchObject({
        reason: "No classification for tool.call.",
      });
    });
  });

  describe("subject isolation", () => {
    it("does not let one preset use another's authority", async () => {
      await grant(fsRead("/p"), { kind: "persistent" }, preset("canvas", 1));

      await expect(
        authorizer({ global: "ask" }).decide(request(fsRead("/p")))
      ).resolves.toEqual({ kind: "requires-approval" });
    });

    it("does not let a new preset generation inherit the previous one's authority", async () => {
      await grant(fsRead("/p"), { kind: "persistent" }, preset("chat", 3));

      await expect(
        authorizer({ global: "ask" }).decide(
          request(fsRead("/p"), { subject: preset("chat", 4) })
        )
      ).resolves.toEqual({ kind: "requires-approval" });
    });

    it("does not let a capability version change inherit stale authority", async () => {
      await grant(fsRead("/p"), { kind: "persistent" });

      const nextVersion = createAuthorizer({
        addressing: testAddressing(2),
        grants,
        kindOf,
        now: clock.now,
        policy: { global: "ask" },
      });

      await expect(nextVersion.decide(request(fsRead("/p")))).resolves.toEqual({
        kind: "requires-approval",
      });
    });

    it("keeps two capabilities of the same kind separate", async () => {
      await grant(fsRead("/p"), { kind: "persistent" });

      await expect(
        authorizer({ global: "ask" }).decide(request(fsRead("/other")))
      ).resolves.toEqual({ kind: "requires-approval" });
    });
  });

  describe("session authority", () => {
    it("allows inside the scope it was granted for", async () => {
      await grant(fsRead("/p"), { kind: "session", scopeId: "session-1" });

      await expect(
        authorizer({ global: "ask" }).decide(
          request(fsRead("/p"), { scopeId: "session-1" })
        )
      ).resolves.toMatchObject({ kind: "allow", source: "grant" });
    });

    it("does not leak into another scope", async () => {
      await grant(fsRead("/p"), { kind: "session", scopeId: "session-1" });

      await expect(
        authorizer({ global: "ask" }).decide(
          request(fsRead("/p"), { scopeId: "session-2" })
        )
      ).resolves.toEqual({ kind: "requires-approval" });
    });

    it("does not apply to a request that names no scope", async () => {
      await grant(fsRead("/p"), { kind: "session", scopeId: "session-1" });

      await expect(
        authorizer({ global: "ask" }).decide(request(fsRead("/p")))
      ).resolves.toEqual({ kind: "requires-approval" });
    });
  });

  describe("expiry and revocation", () => {
    it("treats expired authority as absent", async () => {
      await grants.issue({
        address: addressing.addressOf(SUBJECT, fsRead("/p")),
        capability: fsRead("/p"),
        expiresAt: 1500,
        lifetime: { kind: "persistent" },
        provenance: "human",
      });

      await expect(
        authorizer({ global: "ask" }).decide(request(fsRead("/p")))
      ).resolves.toMatchObject({ kind: "allow" });

      clock.advance(1000);
      await expect(
        authorizer({ global: "ask" }).decide(request(fsRead("/p")))
      ).resolves.toEqual({ kind: "requires-approval" });
    });

    it("treats revoked authority as absent", async () => {
      const issued = await grant(fsRead("/p"), { kind: "persistent" });
      await grants.revoke(issued.id);

      await expect(
        authorizer({ global: "ask" }).decide(request(fsRead("/p")))
      ).resolves.toEqual({ kind: "requires-approval" });
    });
  });

  /**
   * The hazard this whole split exists for. The agent path evaluates every tool
   * call twice — once in the SDK's `needsApproval`, once defensively before
   * executing — so a decision that consumed a one-shot grant would spend it
   * before the real invocation ran.
   */
  describe("decisions do not consume authority", () => {
    it("answers a one-shot grant the same way however often it is asked", async () => {
      const issued = await grant(fsRead("/p"), { kind: "once" });
      const policy = authorizer({ global: "ask" });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(policy.decide(request(fsRead("/p")))).resolves.toEqual({
          grantId: issued.id,
          grantRevision: issued.revision,
          kind: "allow",
          source: "grant",
        });
      }
    });

    it("prefers durable authority so a one-shot is not spent for nothing", async () => {
      const once = await grant(fsRead("/p"), { kind: "once" });
      const persistent = await grant(fsRead("/p"), { kind: "persistent" });

      const decision = await authorizer({ global: "ask" }).decide(
        request(fsRead("/p"))
      );

      expect(decision).toMatchObject({ grantId: persistent.id });
      expect(decision).not.toMatchObject({ grantId: once.id });
    });
  });

  describe("claiming at the effect boundary", () => {
    it("consumes a one-shot grant exactly once", async () => {
      await grant(fsRead("/p"), { kind: "once" });
      const policy = authorizer({ global: "ask" });
      const call = request(fsRead("/p"));

      const decision = await policy.decide(call);
      const claim = await policy.claim(call, decision);
      expect(claim).toMatchObject({
        invocationId: "invocation-1",
        kind: "authorized",
      });

      // Spent — a later call must ask again.
      await expect(policy.decide(call)).resolves.toEqual({
        kind: "requires-approval",
      });
    });

    it("lets the same invocation replay its claim", async () => {
      await grant(fsRead("/p"), { kind: "once" });
      const policy = authorizer({ global: "ask" });
      const call = request(fsRead("/p"));
      const decision = await policy.decide(call);

      const first = await policy.claim(call, decision);
      const replay = await policy.claim(call, decision);

      expect(replay).toEqual(first);
    });

    it("refuses a different invocation presenting the spent grant", async () => {
      await grant(fsRead("/p"), { kind: "once" });
      const policy = authorizer({ global: "ask" });
      const decision = await policy.decide(request(fsRead("/p")));

      await policy.claim(request(fsRead("/p")), decision);
      const other = await policy.claim(
        request(fsRead("/p"), { invocationId: "invocation-2" }),
        decision
      );

      expect(other).toMatchObject({ kind: "denied" });
    });

    it("claims nothing when policy allowed without a grant", async () => {
      const policy = authorizer({ global: "allow" });
      const call = request(fsRead("/p"));

      const claim = await policy.claim(call, await policy.decide(call));
      expect(claim).toEqual({
        invocationId: "invocation-1",
        kind: "authorized",
      });
    });

    it("denies when authority was revoked between deciding and claiming", async () => {
      const issued = await grant(fsRead("/p"), { kind: "persistent" });
      const policy = authorizer({ global: "ask" });
      const call = request(fsRead("/p"));
      const decision = await policy.decide(call);

      await grants.revoke(issued.id);

      await expect(policy.claim(call, decision)).resolves.toMatchObject({
        kind: "denied",
      });
    });

    it("refuses to run an unresolved decision", async () => {
      const policy = authorizer({ global: "ask" });
      const call = request(fsRead("/p"));

      await expect(
        policy.claim(call, await policy.decide(call))
      ).resolves.toMatchObject({ kind: "denied" });
    });

    it("refuses to run a denied decision, carrying its reason", async () => {
      const policy = authorizer({ global: "deny" });
      const call = request(fsRead("/p"));

      await expect(
        policy.claim(call, await policy.decide(call))
      ).resolves.toEqual({
        kind: "denied",
        reason: "Denied by global policy.",
      });
    });
  });

  describe("resolving an approval", () => {
    it("denies when the human said no", async () => {
      const decision = await authorizer({ global: "ask" }).resolveApproval(
        request(fsRead("/p")),
        { approved: false, reason: "Not this time." }
      );

      expect(decision).toEqual({
        kind: "deny",
        reason: "Not this time.",
        source: "approval",
      });
    });

    it("treats an approval with no lifetime as this invocation only", async () => {
      const policy = authorizer({ global: "ask" });
      const call = request(fsRead("/p"));

      const decision = await policy.resolveApproval(call, { approved: true });
      expect(decision).toEqual({ kind: "allow", source: "approval" });

      // No durable authority was written, so the next call asks again.
      await expect(policy.decide(call)).resolves.toEqual({
        kind: "requires-approval",
      });
    });

    it("issues durable authority for a persistent approval", async () => {
      const policy = authorizer({ global: "ask" });
      const call = request(fsRead("/p"));

      const decision = await policy.resolveApproval(call, {
        approved: true,
        lifetime: "persistent",
      });
      expect(decision).toMatchObject({ kind: "allow", source: "approval" });

      await expect(policy.decide(call)).resolves.toMatchObject({
        kind: "allow",
        source: "grant",
      });
    });

    it("records a persistent approval as a human decision", async () => {
      const policy = authorizer({ global: "ask" });
      await policy.resolveApproval(request(fsRead("/p")), {
        approved: true,
        lifetime: "persistent",
      });

      const [issued] = await grants.find(
        addressing.addressOf(SUBJECT, fsRead("/p")),
        clock.now()
      );
      expect(issued?.provenance).toBe("human");
    });

    it("scopes a session approval to the request's scope", async () => {
      const policy = authorizer({ global: "ask" });
      const call = request(fsRead("/p"), { scopeId: "session-1" });

      await policy.resolveApproval(call, {
        approved: true,
        lifetime: "session",
      });

      await expect(policy.decide(call)).resolves.toMatchObject({
        kind: "allow",
        source: "grant",
      });
      await expect(
        policy.decide(request(fsRead("/p"), { scopeId: "session-2" }))
      ).resolves.toEqual({ kind: "requires-approval" });
    });

    it("refuses a session approval that cannot name its session", async () => {
      const decision = await authorizer({ global: "ask" }).resolveApproval(
        request(fsRead("/p")),
        { approved: true, lifetime: "session" }
      );

      expect(decision).toMatchObject({ kind: "deny", source: "approval" });
      await expect(
        grants.find(addressing.addressOf(SUBJECT, fsRead("/p")), clock.now())
      ).resolves.toEqual([]);
    });

    it("lets an exact deny added while parked override the approval", async () => {
      const decision = await authorizer({
        exactDenies: [
          {
            capability: fsRead("/p"),
            reason: "Revoked while the call was parked.",
            subject: SUBJECT,
          },
        ],
        global: "ask",
      }).resolveApproval(request(fsRead("/p")), {
        approved: true,
        lifetime: "persistent",
      });

      expect(decision).toEqual({
        kind: "deny",
        reason: "Revoked while the call was parked.",
        source: "policy",
      });
      await expect(
        grants.find(addressing.addressOf(SUBJECT, fsRead("/p")), clock.now())
      ).resolves.toEqual([]);
    });
  });

  describe("live policy", () => {
    it("reads a source per decision, so a mode change takes effect", async () => {
      let global: TestPolicy["global"] = "deny";
      const policy = createAuthorizer({
        addressing,
        grants,
        kindOf,
        now: clock.now,
        policy: { current: (): TestPolicy => ({ global }) },
      });

      await expect(policy.decide(request(fsRead("/p")))).resolves.toMatchObject(
        { kind: "deny" }
      );

      global = "allow";
      await expect(policy.decide(request(fsRead("/p")))).resolves.toMatchObject(
        { kind: "allow" }
      );
    });

    /**
     * One decision must answer from one configuration. Reading the source
     * again after the repository lookup would let a settings write land
     * mid-decision, and the same call could then deny on one tier while
     * allowing on another.
     */
    it("snapshots one coherent policy per decision", async () => {
      const current = vi.fn((): TestPolicy => ({ global: "ask" }));
      const policy = createAuthorizer({
        addressing,
        grants,
        kindOf,
        now: clock.now,
        policy: { current },
      });

      await policy.decide(request(fsRead("/p")));
      expect(current).toHaveBeenCalledTimes(1);
    });
  });

  describe("the event stream", () => {
    it("records the human decisions and the claims", async () => {
      const emit = vi.fn<(event: TestEvent) => void>();
      const policy = createAuthorizer({
        addressing,
        events: { emit },
        grants,
        kindOf,
        now: clock.now,
        policy: { global: "ask" },
      });
      const call = request(fsRead("/p"));

      const approved = await policy.resolveApproval(call, {
        approved: true,
        lifetime: "persistent",
      });
      await policy.claim(call, approved);

      expect(emit.mock.calls.map(([event]) => event.kind)).toEqual([
        "approved",
        "claimed",
      ]);
    });

    it("stays silent for a decision, which changes nothing", async () => {
      const emit = vi.fn<(event: TestEvent) => void>();
      await createAuthorizer({
        addressing,
        events: { emit },
        grants,
        kindOf,
        now: clock.now,
        policy: { global: "ask" },
      }).decide(request(fsRead("/p")));

      expect(emit).not.toHaveBeenCalled();
    });
  });
});
