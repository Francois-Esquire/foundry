import { describe, expect, it } from "vitest";
import {
  Authorization,
  AuthorizationDeniedError,
  type AuthorizationEvent,
  AuthorizationPendingError,
  AuthorizationRevisionError,
  AuthorizationStateError,
  AuthorizationValidationError,
  grantId,
  type Principal,
  restrictionId,
  withPermit,
} from "../index";
import { MemoryAuthorizationStore } from "../store/memory";

function createClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
  };
}

describe("Authorization end-to-end control plane", () => {
  it("C1: supports agent live reusable, deferred pending approval, one-shot consumption, and replay guard", async () => {
    const clock = createClock();
    const auth = new Authorization({
      clock: clock.now,
      store: new MemoryAuthorizationStore(),
    });
    const agent: Principal = { id: "agent-1", kind: "agent" };
    const human: Principal = { id: "alice", kind: "user" };
    const req = {
      action: "shell.exec",
      attributes: { command: "git status" },
      principal: agent,
      sessionId: "sess-1",
      target: "/workspace",
    };

    expect((await auth.check(req)).kind).toBe("ask");

    const pendingOutcome = await auth.authorize(req, "inv-once-1");
    expect(pendingOutcome.kind).toBe("pending");
    if (pendingOutcome.kind !== "pending") {
      throw new Error("expected pending");
    }
    const retryPending = await auth.authorize(req, "inv-once-1");
    expect(retryPending).toEqual(pendingOutcome);

    await auth.approve(pendingOutcome.grant.id, {
      approver: human,
      rootAuthority: true,
      usesRemaining: 1,
    });

    const firstPermit = await auth.authorize(req, "inv-once-1");
    expect(firstPermit.kind).toBe("permitted");
    if (firstPermit.kind !== "permitted") {
      throw new Error("expected permitted");
    }
    firstPermit.permit.release();

    const replayBlocked = await auth.authorize(req, "inv-once-1");
    expect(replayBlocked.kind).toBe("denied");

    const idempotentRetry = await auth.authorize(req, "inv-once-1", {
      idempotent: true,
    });
    expect(idempotentRetry.kind).toBe("permitted");
    if (idempotentRetry.kind === "permitted") {
      idempotentRetry.permit.release();
    }

    const secondInvocation = await auth.authorize(req, "inv-once-2", {
      openPending: false,
    });
    expect(secondInvocation.kind).toBe("denied");

    const reusable = await auth.grant({
      holder: { kind: "exact", principal: agent },
      requestedBy: human,
      scope: {
        action: "shell.exec",
        constraints: { command: { op: "commandPrefix", value: "git" } },
        target: { kind: "exact", value: "/workspace" },
      },
      sessionId: "sess-1",
    });
    const oneShot = await auth.grant({
      holder: { kind: "exact", principal: agent },
      requestedBy: human,
      scope: {
        action: "shell.exec",
        constraints: { command: { op: "commandPrefix", value: "git status" } },
        target: { kind: "exact", value: "/workspace" },
      },
      sessionId: "sess-1",
      usesRemaining: 1,
    });

    const result = await withPermit(
      auth,
      req,
      "inv-reusable",
      async (permit) => {
        expect(permit.receipt.grantId).toBe(reusable.id);
        return "ok";
      }
    );
    expect(result).toBe("ok");
    expect((await auth.getGrant(oneShot.id))?.usesRemaining).toBe(1);
  });

  it("C2: supports module preflight, delegated sub-module grant, issuance group revoke, and live Permit abort", async () => {
    const auth = new Authorization({ store: new MemoryAuthorizationStore() });
    const host: Principal = { id: "works-host", kind: "host" };
    const modA: Principal = { id: "mod-a", kind: "module", version: "1.0.0" };
    const modB: Principal = { id: "mod-b", kind: "module", version: "1.0.0" };

    const rootGrant = await auth.grant({
      canDelegate: true,
      holder: { kind: "exact", principal: modA },
      issuanceKey: "install:mod-a:v1",
      requestedBy: host,
      scope: {
        action: "net.fetch",
        constraints: { host: { op: "domainSuffix", value: "api.example.com" } },
        target: { kind: "any" },
      },
    });
    const subGrant = await auth.grant({
      holder: { kind: "exact", principal: modB },
      issuer: modA,
      parentIds: [rootGrant.id],
      requestedBy: modA,
      scope: {
        action: "net.fetch",
        constraints: {
          host: { op: "domainSuffix", value: "v2.api.example.com" },
        },
        target: { kind: "exact", value: "/items" },
      },
    });

    const subRequest = {
      action: "net.fetch",
      attributes: { host: "v2.api.example.com" },
      principal: modB,
      target: "/items",
    };
    const decision = await auth.check(subRequest);
    expect(decision).toEqual({
      grantId: subGrant.id,
      grantPath: [subGrant.id, rootGrant.id],
      kind: "allow",
    });

    const outcome = await auth.authorize(subRequest, "inv-mod-b");
    expect(outcome.kind).toBe("permitted");
    if (outcome.kind !== "permitted") {
      throw new Error("expected permitted");
    }
    expect(outcome.permit.signal.aborted).toBe(false);

    const revoked = await auth.revoke(
      { issuanceKey: "install:mod-a:v1", kind: "issuance" },
      "module uninstalled"
    );
    expect(revoked).toEqual([rootGrant.id]);
    expect(outcome.permit.signal.aborted).toBe(true);
    outcome.permit.release();

    expect((await auth.check(subRequest)).kind).toBe("ask");
  });

  it("C3: supports workflow step gate via pending grant request, denial, and withPermit error mapping", async () => {
    const auth = new Authorization({ store: new MemoryAuthorizationStore() });
    const workflow: Principal = { id: "deploy-prod", kind: "workflow" };
    const reviewer: Principal = { id: "ops-lead", kind: "user" };
    const req = {
      action: "deploy.promote",
      principal: workflow,
      target: "production",
    };

    const gate = await auth.request({
      holder: { kind: "exact", principal: workflow },
      invocationId: "step-promote-1",
      reason: "Promote build 42 to production",
      requestedBy: workflow,
      scope: {
        action: "deploy.promote",
        target: { kind: "exact", value: "production" },
      },
      usesRemaining: 1,
    });
    expect(gate.state).toBe("pending");

    await expect(
      withPermit(auth, req, "step-promote-1", async () => "never")
    ).rejects.toBeInstanceOf(AuthorizationPendingError);

    const denied = await auth.deny(gate.id, {
      approver: reviewer,
      reason: "Freeze window active",
    });
    expect(denied.state).toBe("denied");
    expect(denied.deniedBy?.reason).toBe("Freeze window active");

    await expect(
      withPermit(auth, req, "step-promote-1", async () => "never")
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
  });

  it("C4: enforces employee spend threshold, manager delegation approval, anti-self-approval, quorum, and ceiling rejection", async () => {
    const clock = createClock();
    const auth = new Authorization({
      clock: clock.now,
      store: new MemoryAuthorizationStore(),
    });
    const financeRoot: Principal = { id: "cfo", kind: "user" };
    const managerA: Principal = { id: "mgr-a", kind: "user" };
    const managerB: Principal = { id: "mgr-b", kind: "user" };
    const employee: Principal = { id: "emp-1", kind: "user" };

    const managerAGrant = await auth.grant({
      canDelegate: true,
      expiresAt: clock.now() + 60_000,
      holder: { kind: "exact", principal: managerA },
      requestedBy: financeRoot,
      scope: {
        action: "expense.spend",
        constraints: { amount: { max: 5000, min: 0, op: "range" } },
        target: { kind: "prefix", value: "cost-center/eng" },
      },
    });
    const managerBGrant = await auth.grant({
      canDelegate: true,
      expiresAt: clock.now() + 60_000,
      holder: { kind: "exact", principal: managerB },
      requestedBy: financeRoot,
      scope: {
        action: "expense.spend",
        constraints: { amount: { max: 5000, min: 0, op: "range" } },
        target: { kind: "prefix", value: "cost-center/eng" },
      },
    });

    const overCeiling = await auth.request({
      expiresAt: clock.now() + 10_000,
      holder: { kind: "exact", principal: employee },
      requestedBy: employee,
      scope: {
        action: "expense.spend",
        constraints: { amount: { max: 10_000, min: 0, op: "range" } },
        target: { kind: "exact", value: "cost-center/eng/hw" },
      },
    });
    await expect(
      auth.approve(overCeiling.id, {
        approver: managerA,
        parentGrantId: managerAGrant.id,
      })
    ).rejects.toBeInstanceOf(AuthorizationStateError);

    const quorumRequest = await auth.request({
      expiresAt: clock.now() + 10_000,
      holder: { kind: "exact", principal: employee },
      requestedBy: employee,
      requiredApprovals: 2,
      scope: {
        action: "expense.spend",
        constraints: { amount: { max: 3000, min: 0, op: "range" } },
        target: { kind: "exact", value: "cost-center/eng/hw" },
      },
      usesRemaining: 1,
    });

    await expect(
      auth.approve(quorumRequest.id, {
        approver: employee,
        rootAuthority: true,
      })
    ).rejects.toThrow("Self-approval");

    const afterFirst = await auth.approve(quorumRequest.id, {
      approver: managerA,
      parentGrantId: managerAGrant.id,
      scope: {
        action: "expense.spend",
        constraints: { amount: { max: 2500, min: 0, op: "range" } },
        target: { kind: "exact", value: "cost-center/eng/hw" },
      },
    });
    expect(afterFirst.state).toBe("pending");
    expect(afterFirst.approvals).toHaveLength(1);

    await expect(
      auth.approve(quorumRequest.id, {
        approver: managerA,
        parentGrantId: managerAGrant.id,
      })
    ).rejects.toThrow("already approved");

    const afterSecond = await auth.approve(quorumRequest.id, {
      approver: managerB,
      parentGrantId: managerBGrant.id,
    });
    expect(afterSecond.state).toBe("active");
    expect(afterSecond.parentIds).toEqual([managerAGrant.id, managerBGrant.id]);

    const okRequest = {
      action: "expense.spend",
      attributes: { amount: 2000 },
      principal: employee,
      target: "cost-center/eng/hw",
    };
    const overTightened = {
      ...okRequest,
      attributes: { amount: 2800 },
    };
    expect((await auth.check(overTightened)).kind).toBe("ask");
    expect((await auth.check(okRequest)).kind).toBe("allow");

    await auth.revoke({ grantId: managerBGrant.id, kind: "grant" });
    expect((await auth.check(okRequest)).kind).toBe("ask");
  });

  it("C5: enforces subagent attenuation ceilings and subtree invalidation on parent revocation", async () => {
    const clock = createClock();
    const auth = new Authorization({
      clock: clock.now,
      store: new MemoryAuthorizationStore(),
    });
    const host: Principal = { id: "host", kind: "host" };
    const parentAgent: Principal = { id: "planner", kind: "agent" };
    const subAgent: Principal = { id: "worker", kind: "agent" };

    const parentGrant = await auth.grant({
      canDelegate: true,
      expiresAt: clock.now() + 30_000,
      holder: { kind: "exact", principal: parentAgent },
      requestedBy: host,
      scope: {
        action: "file.write",
        target: { kind: "prefix", value: "/workspace/" },
      },
      sessionId: "sess-9",
      usesRemaining: 5,
    });

    await expect(
      auth.grant({
        expiresAt: clock.now() + 60_000,
        holder: { kind: "exact", principal: subAgent },
        parentIds: [parentGrant.id],
        requestedBy: parentAgent,
        scope: {
          action: "file.write",
          target: { kind: "exact", value: "/workspace/a.ts" },
        },
        sessionId: "sess-9",
        usesRemaining: 2,
      })
    ).rejects.toBeInstanceOf(AuthorizationStateError);

    await expect(
      auth.grant({
        expiresAt: clock.now() + 10_000,
        holder: { kind: "exact", principal: subAgent },
        parentIds: [parentGrant.id],
        requestedBy: parentAgent,
        scope: {
          action: "file.write",
          target: { kind: "exact", value: "/workspace/a.ts" },
        },
        sessionId: "sess-9",
        usesRemaining: 10,
      })
    ).rejects.toBeInstanceOf(AuthorizationStateError);

    const childGrant = await auth.grant({
      expiresAt: clock.now() + 10_000,
      holder: { kind: "exact", principal: subAgent },
      parentIds: [parentGrant.id],
      requestedBy: parentAgent,
      scope: {
        action: "file.write",
        target: { kind: "prefix", value: "/workspace/src/" },
      },
      sessionId: "sess-9",
      usesRemaining: 2,
    });

    const req = {
      action: "file.write",
      principal: subAgent,
      sessionId: "sess-9",
      target: "/workspace/src/app.ts",
    };
    const outcome = await auth.authorize(req, "inv-sub-1");
    expect(outcome.kind).toBe("permitted");
    if (outcome.kind !== "permitted") {
      throw new Error("expected permitted");
    }
    expect(outcome.permit.receipt.grantPath).toEqual([
      childGrant.id,
      parentGrant.id,
    ]);

    const updatedParent = await auth.getGrant(parentGrant.id);
    expect(updatedParent?.usesRemaining).toBe(4);
    expect(updatedParent?.revision).toBe(2);

    await expect(
      auth.revoke({
        expectedRevision: 99,
        grantId: parentGrant.id,
        kind: "grant",
      })
    ).rejects.toBeInstanceOf(AuthorizationRevisionError);

    await auth.revoke(
      {
        expectedRevision: updatedParent?.revision,
        grantId: parentGrant.id,
        kind: "grant",
      },
      "parent session ended"
    );
    expect(outcome.permit.signal.aborted).toBe(true);
    outcome.permit.release();
    expect((await auth.check(req)).kind).toBe("ask");
  });

  it("C6: aborts live permits when a dynamic deny restriction is added and restores access when lifted", async () => {
    const auth = new Authorization({ store: new MemoryAuthorizationStore() });
    const events: AuthorizationEvent[] = [];
    const unwatch = auth.watch((event) => {
      events.push(event);
    });

    const host: Principal = { id: "host", kind: "host" };
    const agent: Principal = { id: "agent-1", kind: "agent" };
    await auth.grant({
      holder: { kind: "any" },
      requestedBy: host,
      scope: {
        action: "shell.exec",
        target: { kind: "any" },
      },
    });

    const rmReq = {
      action: "shell.exec",
      attributes: { command: "rm -rf /tmp/cache" },
      principal: agent,
      target: "/workspace",
    };
    const outcome = await auth.authorize(rmReq, "inv-live-rm");
    expect(outcome.kind).toBe("permitted");
    if (outcome.kind !== "permitted") {
      throw new Error("expected permitted");
    }
    expect(outcome.permit.signal.aborted).toBe(false);

    const denyRm = await auth.restrict({
      kind: "deny",
      reason: "Destructive rm commands disabled",
      scope: {
        action: "shell.exec",
        constraints: { command: { op: "commandPrefix", value: "rm -rf" } },
        target: { kind: "any" },
      },
    });
    expect(outcome.permit.signal.aborted).toBe(true);
    expect(outcome.permit.signal.reason).toBeInstanceOf(
      AuthorizationDeniedError
    );
    outcome.permit.release();

    const blocked = await auth.check(rmReq);
    expect(blocked).toEqual({
      kind: "deny",
      reason: "Destructive rm commands disabled",
      restrictionId: denyRm.id,
    });

    const missingAttrBlocked = await auth.check({
      action: "shell.exec",
      principal: agent,
      target: "/workspace",
    });
    expect(missingAttrBlocked.kind).toBe("deny");

    await auth.liftRestriction(denyRm.id);
    expect((await auth.check(rmReq)).kind).toBe("allow");

    const requireDirect = await auth.restrict({
      kind: "require-direct-grant",
      reason: "Direct grant required for shell.exec",
      scope: {
        action: "shell.exec",
        target: { kind: "any" },
      },
    });
    const needsDirect = await auth.check(rmReq);
    expect(needsDirect).toEqual({
      kind: "ask",
      reason: "Direct grant required for shell.exec",
      restrictionId: requireDirect.id,
    });

    await auth.grant({
      holder: { kind: "exact", principal: agent },
      requestedBy: host,
      scope: { action: "shell.exec", target: { kind: "any" } },
    });
    expect((await auth.check(rmReq)).kind).toBe("allow");

    unwatch();
    expect(events.map((event) => event.type)).toContain("restriction.added");
    expect(events.map((event) => event.type)).toContain("restriction.lifted");
  });

  it("enforces Cycle 1 adversarial security invariants", async () => {
    const auth = new Authorization({ store: new MemoryAuthorizationStore() });
    const host: Principal = { id: "host", kind: "host" };
    const manager: Principal = { id: "carol", kind: "employee" };
    const agent: Principal = { id: "agent-1", kind: "agent" };

    const finiteParent = await auth.grant({
      canDelegate: true,
      holder: { kind: "exact", principal: manager },
      requestedBy: host,
      scope: { action: "deploy.run", target: { kind: "any" } },
      usesRemaining: 1,
    });
    const childOne = await auth.grant({
      holder: { kind: "exact", principal: agent },
      issuer: manager,
      parentIds: [finiteParent.id],
      requestedBy: manager,
      scope: { action: "deploy.run", target: { kind: "exact", value: "api" } },
      usesRemaining: 1,
    });
    const childTwo = await auth.grant({
      holder: { kind: "exact", principal: agent },
      issuer: manager,
      parentIds: [finiteParent.id],
      requestedBy: manager,
      scope: { action: "deploy.run", target: { kind: "exact", value: "api" } },
      usesRemaining: 1,
    });
    const deployReq = {
      action: "deploy.run",
      principal: agent,
      target: "api",
    };
    const firstDeploy = await auth.authorize(deployReq, "inv-d1", {
      openPending: false,
    });
    expect(firstDeploy.kind).toBe("permitted");
    if (firstDeploy.kind === "permitted") {
      firstDeploy.permit.release();
    }
    expect((await auth.getGrant(finiteParent.id))?.state).toBe("exhausted");
    expect(
      (await auth.authorize(deployReq, "inv-d2", { openPending: false })).kind
    ).toBe("denied");
    expect(childOne.id).not.toBe(childTwo.id);

    const toolReq = { action: "tool.run", principal: agent, target: "bash" };
    const pendingA = await auth.authorize(toolReq, "inv-A");
    expect(pendingA.kind).toBe("pending");
    if (pendingA.kind !== "pending") {
      throw new Error("expected pending");
    }
    await auth.approve(pendingA.grant.id, {
      approver: host,
      rootAuthority: true,
      usesRemaining: 1,
    });
    expect(
      (await auth.authorize(toolReq, "inv-B", { openPending: false })).kind
    ).toBe("denied");
    const permittedA = await auth.authorize(toolReq, "inv-A");
    expect(permittedA.kind).toBe("permitted");
    if (permittedA.kind === "permitted") {
      permittedA.permit.release();
    }

    const nestedDenied = await auth.authorize(
      {
        action: "tool.run",
        attributes: { args: { path: "/tmp/a" } },
        principal: agent,
        target: "write",
      },
      "inv-nested"
    );
    expect(nestedDenied.kind).toBe("denied");

    const fixedId = grantId("fixed-grant");
    await auth.grant({
      holder: { kind: "exact", principal: agent },
      id: fixedId,
      requestedBy: host,
      scope: { action: "file.read", target: { kind: "exact", value: "/a" } },
    });
    await auth.revoke({ grantId: fixedId, kind: "grant" });
    await expect(
      auth.grant({
        holder: { kind: "exact", principal: agent },
        id: fixedId,
        requestedBy: host,
        scope: { action: "file.read", target: { kind: "exact", value: "/a" } },
      })
    ).rejects.toThrow(AuthorizationValidationError);

    const fixedRestriction = restrictionId("fixed-deny");
    await auth.restrict({
      id: fixedRestriction,
      kind: "deny",
      reason: "blocked",
      scope: { action: "file.write", target: { kind: "any" } },
    });
    await expect(
      auth.restrict({
        id: fixedRestriction,
        kind: "deny",
        reason: "overwrite attempt",
        scope: { action: "file.write", target: { kind: "exact", value: "/x" } },
      })
    ).rejects.toThrow(AuthorizationValidationError);

    const unwatchThrowing = auth.watch(() => {
      throw new Error("observer failure");
    });
    const revocable = await auth.grant({
      holder: { kind: "exact", principal: agent },
      requestedBy: host,
      scope: { action: "net.call", target: { kind: "any" } },
    });
    const live = await auth.authorize(
      { action: "net.call", principal: agent, target: "https://a.test" },
      "inv-throw-watch"
    );
    expect(live.kind).toBe("permitted");
    if (live.kind !== "permitted") {
      throw new Error("expected permitted");
    }
    await auth.revoke({ grantId: revocable.id, kind: "grant" });
    expect(live.permit.signal.aborted).toBe(true);
    live.permit.release();
    unwatchThrowing();
  });

  it("enforces CodeRabbit review invariants for clock skew, replay/pending binding, expiry, snapshots, issuance bounds, proto keys, and aborted permits", async () => {
    const clock = createClock(100);
    const backing = new MemoryAuthorizationStore();
    let advanceOnList = 0;
    const delayedStore = {
      commit: backing.commit.bind(backing),
      durability: backing.durability,
      getClaim: backing.getClaim.bind(backing),
      getGrant: backing.getGrant.bind(backing),
      getRestriction: backing.getRestriction.bind(backing),
      async listGrants(query?: Parameters<typeof backing.listGrants>[0]) {
        const result = await backing.listGrants(query);
        if (advanceOnList > 0) {
          clock.advance(advanceOnList);
          advanceOnList = 0;
        }
        return result;
      },
      listRestrictions: backing.listRestrictions.bind(backing),
    };
    const auth = new Authorization({ clock: clock.now, store: delayedStore });
    const host: Principal = { id: "host", kind: "host" };
    const agent: Principal = { id: "agent-1", kind: "agent" };

    await auth.grant({
      expiresAt: 105,
      holder: { kind: "exact", principal: agent },
      requestedBy: host,
      scope: { action: "file.read", target: { kind: "exact", value: "/exp" } },
    });
    const expReq = {
      action: "file.read",
      principal: agent,
      target: "/exp",
    };
    advanceOnList = 10;
    expect((await auth.check(expReq)).kind).toBe("ask");
    expect(
      (await auth.authorize(expReq, "inv-exp-check", { openPending: false }))
        .kind
    ).toBe("denied");

    await auth.grant({
      holder: { kind: "exact", principal: agent },
      requestedBy: host,
      scope: {
        action: "file.read",
        target: { kind: "prefix", value: "/workspace/" },
      },
      usesRemaining: 1,
    });
    const reqA = {
      action: "file.read",
      principal: agent,
      target: "/workspace/a.ts",
    };
    const reqB = {
      action: "file.read",
      principal: agent,
      target: "/workspace/b.ts",
    };
    const first = await auth.authorize(reqA, "inv-bound-1");
    expect(first.kind).toBe("permitted");
    if (first.kind === "permitted") {
      first.permit.release();
    }
    const replaySame = await auth.authorize(reqA, "inv-bound-1", {
      idempotent: true,
    });
    expect(replaySame.kind).toBe("permitted");
    if (replaySame.kind === "permitted") {
      replaySame.permit.release();
    }
    const replayOther = await auth.authorize(reqB, "inv-bound-1", {
      idempotent: true,
    });
    expect(replayOther.kind).toBe("denied");

    const pendA = await auth.authorize(reqA, "inv-pend-1");
    expect(pendA.kind).toBe("pending");
    const pendSame = await auth.authorize(reqA, "inv-pend-1");
    expect(pendSame).toEqual(pendA);
    const pendOther = await auth.authorize(reqB, "inv-pend-1");
    expect(pendOther.kind).toBe("denied");

    const expPending = await auth.request({
      expiresAt: clock.now() + 50,
      holder: { kind: "exact", principal: agent },
      invocationId: "inv-pend-exp",
      requestedBy: agent,
      scope: { action: "deploy.run", target: { kind: "exact", value: "prod" } },
    });
    expect(expPending.state).toBe("pending");
    clock.advance(50);
    expect(
      (
        await auth.authorize(
          { action: "deploy.run", principal: agent, target: "prod" },
          "inv-pend-exp"
        )
      ).kind
    ).toBe("denied");
    await expect(
      auth.request({
        expiresAt: clock.now() + 50,
        holder: { kind: "exact", principal: agent },
        invocationId: "inv-pend-exp",
        requestedBy: agent,
        scope: {
          action: "deploy.run",
          target: { kind: "exact", value: "prod" },
        },
      })
    ).rejects.toBeInstanceOf(AuthorizationStateError);

    const mutableAttrs: Record<string, string> = { department: "eng" };
    await auth.grant({
      holder: { kind: "exact", principal: agent },
      requestedBy: host,
      scope: { action: "db.query", target: { kind: "any" } },
    });
    const snapOutcome = await auth.authorize(
      {
        action: "db.query",
        attributes: mutableAttrs,
        principal: agent,
        target: "main",
      },
      "inv-snap"
    );
    expect(snapOutcome.kind).toBe("permitted");
    if (snapOutcome.kind !== "permitted") {
      throw new Error("expected permitted");
    }
    mutableAttrs.department = "ops";
    await auth.restrict({
      kind: "deny",
      reason: "eng blocked",
      scope: {
        action: "db.query",
        constraints: { department: { op: "eq", value: "eng" } },
        target: { kind: "any" },
      },
    });
    expect(snapOutcome.permit.signal.aborted).toBe(true);
    snapOutcome.permit.release();

    const firstIssued = await auth.grant({
      holder: { kind: "exact", principal: agent },
      issuanceKey: "iss-bounds",
      requestedBy: host,
      scope: { action: "cache.clear", target: { kind: "any" } },
      usesRemaining: 10,
    });
    const exactRetry = await auth.grant({
      holder: { kind: "exact", principal: agent },
      issuanceKey: "iss-bounds",
      requestedBy: host,
      scope: { action: "cache.clear", target: { kind: "any" } },
      usesRemaining: 10,
    });
    expect(exactRetry.id).toBe(firstIssued.id);
    await expect(
      auth.grant({
        holder: { kind: "exact", principal: agent },
        issuanceKey: "iss-bounds",
        requestedBy: host,
        scope: { action: "cache.clear", target: { kind: "any" } },
        usesRemaining: 1,
      })
    ).rejects.toBeInstanceOf(AuthorizationStateError);

    const protoAttrs = JSON.parse('{"__proto__":"evil"}') as Record<
      string,
      string
    >;
    const protoPending = await auth.authorize(
      {
        action: "proto.test",
        attributes: protoAttrs,
        principal: agent,
        target: "x",
      },
      "inv-proto"
    );
    expect(protoPending.kind).toBe("pending");
    if (protoPending.kind !== "pending") {
      throw new Error("expected pending");
    }
    expect(
      Object.hasOwn(protoPending.grant.scope.constraints ?? {}, "__proto__")
    ).toBe(true);
    await auth.approve(protoPending.grant.id, {
      approver: host,
      rootAuthority: true,
    });
    expect(
      (
        await auth.check({
          action: "proto.test",
          invocationId: "inv-proto",
          principal: agent,
          target: "x",
        })
      ).kind
    ).toBe("ask");
    expect(
      (
        await auth.check({
          action: "proto.test",
          attributes: protoAttrs,
          invocationId: "inv-proto",
          principal: agent,
          target: "x",
        })
      ).kind
    ).toBe("allow");

    await auth.grant({
      holder: { kind: "exact", principal: agent },
      requestedBy: host,
      scope: { action: "work.run", target: { kind: "exact", value: "job" } },
    });
    const abortController = new AbortController();
    const abortingStore = {
      commit: backing.commit.bind(backing),
      durability: backing.durability,
      getClaim: backing.getClaim.bind(backing),
      getGrant: backing.getGrant.bind(backing),
      getRestriction: backing.getRestriction.bind(backing),
      async listGrants(query?: Parameters<typeof backing.listGrants>[0]) {
        const result = await backing.listGrants(query);
        abortController.abort(new Error("cancelled mid-authorize"));
        return result;
      },
      listRestrictions: backing.listRestrictions.bind(backing),
    };
    const abortAuth = new Authorization({
      clock: clock.now,
      store: abortingStore,
    });
    let workCalled = false;
    await expect(
      withPermit(
        abortAuth,
        { action: "work.run", principal: agent, target: "job" },
        "inv-abort-mid",
        async () => {
          workCalled = true;
          return "done";
        },
        { signal: abortController.signal }
      )
    ).rejects.toThrow("cancelled mid-authorize");
    expect(workCalled).toBe(false);
  });
});
