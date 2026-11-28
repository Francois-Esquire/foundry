import { describe, expect, it } from "vitest";
import {
  agentPrincipal,
  agentPrincipalMatcher,
  agentSubject,
  agentSubjectToPrincipal,
  capabilityToAccessRequest,
  capabilityToScope,
  createMemoryAuthorization,
  HOST_APPROVER,
} from "../../authorization/authorization";
import type { Capability } from "../../authorization/capability";
import { grantCapability } from "../helpers/authorizer";

const WEB: Capability = { domain: "example.com", kind: "web.fetch" };
const TOOL: Capability = {
  kind: "tool.call",
  source: "declared",
  tool: "search",
};

describe("capabilityToScope", () => {
  it("gives every capability kind its own action", () => {
    const actions = [
      capabilityToScope(WEB),
      capabilityToScope({ kind: "mcp.tool", serverId: "s", tool: "t" }),
      capabilityToScope({ kind: "fs.read", projectId: "p", root: "/tmp/p" }),
      capabilityToScope({
        command: { id: "start", version: 1 },
        domain: "runs",
        effect: "write",
        kind: "domain.command",
        target: { projectId: "p", scope: "s" },
      }),
      capabilityToScope(TOOL),
    ].map((scope) => scope.action);

    expect(new Set(actions).size).toBe(actions.length);
  });

  it("cannot collide a domain containing a slash with another domain/command pair", () => {
    const a = capabilityToScope({
      command: { id: "x", version: 1 },
      domain: "runs/start",
      effect: "read",
      kind: "domain.command",
      target: { projectId: "p", scope: "s" },
    });
    const b = capabilityToScope({
      command: { id: "start/x", version: 1 },
      domain: "runs",
      effect: "read",
      kind: "domain.command",
      target: { projectId: "p", scope: "s" },
    });

    expect(a.target).not.toEqual(b.target);
  });

  it("separates capabilities that differ only in a constraint", () => {
    const one = capabilityToScope({
      kind: "fs.read",
      projectId: "p",
      root: "/one",
    });
    const two = capabilityToScope({
      kind: "fs.read",
      projectId: "p",
      root: "/two",
    });

    expect(one.constraints).not.toEqual(two.constraints);
  });
});

describe("agentSubject and agentPrincipal", () => {
  it("maps subject identity and generation onto Principal", () => {
    expect(agentSubjectToPrincipal(agentSubject("chat", 2))).toEqual({
      id: "chat",
      kind: "agent",
      version: "2",
    });
    expect(agentSubjectToPrincipal(agentSubject("chat"))).toEqual({
      id: "chat",
      kind: "agent",
    });
  });

  it("keeps two generations of one agent apart", async () => {
    const authorization = createMemoryAuthorization();
    await grantCapability(authorization, "chat", WEB, { agentGeneration: 1 });

    await expect(
      authorization.check(
        capabilityToAccessRequest({
          agentGeneration: 1,
          agentId: "chat",
          capability: WEB,
        })
      )
    ).resolves.toMatchObject({ kind: "allow" });
    await expect(
      authorization.check(
        capabilityToAccessRequest({
          agentGeneration: 2,
          agentId: "chat",
          capability: WEB,
        })
      )
    ).resolves.toMatchObject({ kind: "ask" });
  });
});

describe("Authorization over agent capabilities", () => {
  it("asks by default rather than allowing or silently denying", async () => {
    const authorization = createMemoryAuthorization();

    await expect(
      authorization.check(
        capabilityToAccessRequest({ agentId: "chat", capability: WEB })
      )
    ).resolves.toMatchObject({ kind: "ask" });
  });

  it("allows from a Grant, and only for the agent that holds it", async () => {
    const authorization = createMemoryAuthorization();
    await grantCapability(authorization, "chat", TOOL);

    await expect(
      authorization.check(
        capabilityToAccessRequest({ agentId: "chat", capability: TOOL })
      )
    ).resolves.toMatchObject({ kind: "allow" });
    await expect(
      authorization.check(
        capabilityToAccessRequest({ agentId: "canvas", capability: TOOL })
      )
    ).resolves.toMatchObject({ kind: "ask" });
  });

  it("stops allowing once the Grant is revoked", async () => {
    const authorization = createMemoryAuthorization();
    const grant = await grantCapability(authorization, "chat", WEB);
    await authorization.revoke({ grantId: grant.id, kind: "grant" });

    await expect(
      authorization.check(
        capabilityToAccessRequest({ agentId: "chat", capability: WEB })
      )
    ).resolves.toMatchObject({ kind: "ask" });
  });

  it("does not let a command Grant reach another project, scope, effect, or version", async () => {
    const granted: Capability = {
      command: { id: "start", version: 1 },
      domain: "runs",
      effect: "write",
      kind: "domain.command",
      target: { projectId: "p1", scope: "s1" },
    };
    const authorization = createMemoryAuthorization();
    await grantCapability(authorization, "chat", granted);

    const neighbours: Capability[] = [
      { ...granted, target: { projectId: "p2", scope: "s1" } },
      { ...granted, target: { projectId: "p1", scope: "s2" } },
      { ...granted, effect: "read" },
      { ...granted, command: { id: "start", version: 2 } },
    ];

    await expect(
      authorization.check(
        capabilityToAccessRequest({ agentId: "chat", capability: granted })
      )
    ).resolves.toMatchObject({ kind: "allow" });
    for (const capability of neighbours) {
      await expect(
        authorization.check(
          capabilityToAccessRequest({ agentId: "chat", capability })
        )
      ).resolves.toMatchObject({ kind: "ask" });
    }
  });

  it("honors a deny restriction over authority the agent already holds", async () => {
    const authorization = createMemoryAuthorization();
    await grantCapability(authorization, "chat", WEB);
    await authorization.restrict({
      holder: agentPrincipalMatcher("chat"),
      kind: "deny",
      reason: "Blocked by the host.",
      scope: capabilityToScope(WEB),
    });

    await expect(
      authorization.check(
        capabilityToAccessRequest({ agentId: "chat", capability: WEB })
      )
    ).resolves.toMatchObject({ kind: "deny", reason: "Blocked by the host." });
  });

  it("does not consume a one-shot Grant by checking, spends it at authorize, and refuses another invocation", async () => {
    const authorization = createMemoryAuthorization();
    await grantCapability(authorization, "chat", WEB, { usesRemaining: 1 });
    const first = capabilityToAccessRequest({
      agentId: "chat",
      capability: WEB,
      invocationId: "call-1",
    });

    await expect(authorization.check(first)).resolves.toMatchObject({
      kind: "allow",
    });
    await expect(authorization.check(first)).resolves.toMatchObject({
      kind: "allow",
    });

    const outcome = await authorization.authorize(first, "call-1", {
      openPending: false,
    });
    expect(outcome.kind).toBe("permitted");
    if (outcome.kind === "permitted") {
      outcome.permit.release();
    }

    await expect(
      authorization.authorize(
        capabilityToAccessRequest({
          agentId: "chat",
          capability: WEB,
          invocationId: "call-2",
        }),
        "call-2",
        { openPending: false }
      )
    ).resolves.toMatchObject({ kind: "denied" });
  });

  it("opens a pending grant and activates it on approval", async () => {
    const authorization = createMemoryAuthorization();
    const request = capabilityToAccessRequest({
      agentId: "chat",
      capability: WEB,
      invocationId: "call-1",
    });
    const pending = await authorization.authorize(request, "call-1");
    expect(pending.kind).toBe("pending");
    if (pending.kind !== "pending") {
      throw new Error("expected pending");
    }

    await authorization.approve(pending.grant.id, {
      approver: HOST_APPROVER,
      rootAuthority: true,
      usesRemaining: 1,
    });

    const permitted = await authorization.authorize(request, "call-1", {
      openPending: false,
    });
    expect(permitted.kind).toBe("permitted");
    if (permitted.kind === "permitted") {
      permitted.permit.release();
    }
    expect(agentPrincipal("chat").kind).toBe("agent");
  });
});
