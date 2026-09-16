import { encodeAddress } from "@foundry/lib/config/authorization";
import { describe, expect, it } from "vitest";

import type { Capability } from "../../authorization";

import {
  AGENT_ASK_BY_DEFAULT,
  agentAddressing,
  agentCapabilityAddress,
  agentSubject,
  createAgentAuthorizer,
  createInMemoryAgentAuthorizer,
} from "../../authorization";

const CHAT = agentSubject("chat");
const CANVAS = agentSubject("canvas");

const WEB: Capability = { domain: "example.com", kind: "web.fetch" };
const TOOL: Capability = {
  kind: "tool.call",
  source: "declared",
  tool: "search",
};

function key(subject: typeof CHAT, capability: Capability): string {
  return encodeAddress(agentAddressing.addressOf(subject, capability));
}

describe("agentCapabilityAddress", () => {
  it("gives every capability kind its own namespace", () => {
    const kinds = [
      agentCapabilityAddress(WEB),
      agentCapabilityAddress({ kind: "mcp.tool", serverId: "s", tool: "t" }),
      agentCapabilityAddress({
        kind: "fs.read",
        projectId: "p",
        root: "/tmp/p",
      }),
      agentCapabilityAddress(TOOL),
    ].map((address) => address.namespace);

    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("carries the command catalog's own version for domain.command", () => {
    const address = agentCapabilityAddress({
      command: { id: "start", version: 3 },
      domain: "runs",
      effect: "write",
      kind: "domain.command",
      target: { projectId: "p", scope: "s" },
    });

    expect(address.version).toBe(3);
  });

  /**
   * The old `capabilityKey` hashed the capability payload alone. Encoding the
   * domain and the command id as a joined string would reintroduce the same
   * class of collision one level down.
   */
  it("cannot collide a domain containing the separator with another pair", () => {
    const a = agentCapabilityAddress({
      command: { id: "x", version: 1 },
      domain: "runs/start",
      effect: "read",
      kind: "domain.command",
      target: { projectId: "p", scope: "s" },
    });
    const b = agentCapabilityAddress({
      command: { id: "start/x", version: 1 },
      domain: "runs",
      effect: "read",
      kind: "domain.command",
      target: { projectId: "p", scope: "s" },
    });

    expect(a.id).not.toBe(b.id);
  });

  it("separates capabilities that differ only in a constraint", () => {
    const one = agentCapabilityAddress({
      kind: "fs.read",
      projectId: "p",
      root: "/one",
    });
    const two = agentCapabilityAddress({
      kind: "fs.read",
      projectId: "p",
      root: "/two",
    });

    expect(one.constraintsDigest).not.toBe(two.constraintsDigest);
  });
});

describe("agentAddressing", () => {
  /** The under-namespacing this whole mechanic exists to fix. */
  it("keeps two presets exposing the same tool name apart", () => {
    expect(key(CHAT, TOOL)).not.toBe(key(CANVAS, TOOL));
  });

  it("keeps two generations of one preset apart", () => {
    expect(key(agentSubject("chat", 1), WEB)).not.toBe(
      key(agentSubject("chat", 2), WEB)
    );
  });

  it("addresses an ungenerated preset stably", () => {
    expect(key(CHAT, WEB)).toBe(key(agentSubject("chat"), WEB));
  });
});

describe("createAgentAuthorizer", () => {
  it("asks by default rather than allowing or silently denying", async () => {
    const { authorizer } = createInMemoryAgentAuthorizer();

    await expect(
      authorizer.decide({
        capability: WEB,
        invocationId: "i-1",
        subject: CHAT,
      })
    ).resolves.toMatchObject({ kind: "requires-approval" });
  });

  /**
   * `tool.call` is excluded from the global tier, so a policy that says nothing
   * about it must deny — a blanket `"allow"` meant for classified kinds can
   * never reach an unclassified tool.
   */
  it("fails closed on tool.call under a blanket allow that never named it", async () => {
    const { authorizer } = createInMemoryAgentAuthorizer({
      policy: { global: "allow" },
    });

    await expect(
      authorizer.decide({ capability: WEB, invocationId: "i", subject: CHAT })
    ).resolves.toMatchObject({ kind: "allow" });
    const denied = await authorizer.decide({
      capability: TOOL,
      invocationId: "i",
      subject: CHAT,
    });
    expect(denied.kind).toBe("deny");
    expect(denied.kind === "deny" && denied.reason).toContain('tool "search"');
  });

  it("lets the safe default reach a human for an unclassified tool", async () => {
    const { authorizer } = createInMemoryAgentAuthorizer({
      policy: AGENT_ASK_BY_DEFAULT,
    });

    await expect(
      authorizer.decide({ capability: TOOL, invocationId: "i", subject: CHAT })
    ).resolves.toMatchObject({ kind: "requires-approval" });
  });

  it("allows from a Grant, and only for the Subject that holds it", async () => {
    const policy = createInMemoryAgentAuthorizer();
    await policy.allow(CHAT, TOOL);

    await expect(
      policy.authorizer.decide({
        capability: TOOL,
        invocationId: "i",
        subject: CHAT,
      })
    ).resolves.toMatchObject({ kind: "allow", source: "grant" });
    await expect(
      policy.authorizer.decide({
        capability: TOOL,
        invocationId: "i",
        subject: CANVAS,
      })
    ).resolves.toMatchObject({ kind: "requires-approval" });
  });

  it("stops allowing once the Grant is revoked", async () => {
    const policy = createInMemoryAgentAuthorizer();
    await policy.allow(CHAT, WEB);
    await policy.revoke(CHAT, WEB);

    await expect(
      policy.authorizer.decide({
        capability: WEB,
        invocationId: "i",
        subject: CHAT,
      })
    ).resolves.toMatchObject({ kind: "requires-approval" });
  });

  /**
   * A command Grant is authority over one exact target at one exact version.
   * Widening it along any of those dimensions is the failure the versioned
   * address exists to prevent.
   */
  it("does not let a command Grant reach another project, scope, effect, or version", async () => {
    const granted: Capability = {
      command: { id: "start", version: 1 },
      domain: "runs",
      effect: "write",
      kind: "domain.command",
      target: { projectId: "p1", scope: "s1" },
    };
    const policy = createInMemoryAgentAuthorizer();
    await policy.allow(CHAT, granted);

    const neighbours: Capability[] = [
      { ...granted, target: { projectId: "p2", scope: "s1" } },
      { ...granted, target: { projectId: "p1", scope: "s2" } },
      { ...granted, effect: "read" },
      { ...granted, command: { id: "start", version: 2 } },
    ];

    await expect(
      policy.authorizer.decide({
        capability: granted,
        invocationId: "i",
        subject: CHAT,
      })
    ).resolves.toMatchObject({ kind: "allow", source: "grant" });
    for (const capability of neighbours) {
      await expect(
        policy.authorizer.decide({
          capability,
          invocationId: "i",
          subject: CHAT,
        })
      ).resolves.toMatchObject({ kind: "requires-approval" });
    }
  });

  it("honors an exact deny over authority the Subject already holds", async () => {
    const grants = createInMemoryAgentAuthorizer().grants;
    const authorizer = createAgentAuthorizer({
      grants,
      policy: {
        exactDenies: [
          { capability: WEB, reason: "Blocked by the host.", subject: CHAT },
        ],
        global: "allow",
      },
    });
    await grants.issue({
      address: agentAddressing.addressOf(CHAT, WEB),
      capability: WEB,
      lifetime: { kind: "persistent" },
      provenance: "human",
    });

    await expect(
      authorizer.decide({ capability: WEB, invocationId: "i", subject: CHAT })
    ).resolves.toMatchObject({ kind: "deny", reason: "Blocked by the host." });
  });
});

/**
 * The hazard the split exists for: the agent path evaluates every tool call
 * twice (the AI SDK's `needsApproval`, then defensively in `execute`). If
 * evaluation consumed authority, a one-shot Grant would be spent before the
 * real invocation ever ran.
 */
describe("decide versus claim", () => {
  it("does not consume a one-shot Grant by deciding", async () => {
    const policy = createInMemoryAgentAuthorizer();
    await policy.allow(CHAT, WEB, { kind: "once" });
    const request = { capability: WEB, invocationId: "call-1", subject: CHAT };

    await expect(policy.authorizer.decide(request)).resolves.toMatchObject({
      kind: "allow",
      source: "grant",
    });
    await expect(policy.authorizer.decide(request)).resolves.toMatchObject({
      kind: "allow",
      source: "grant",
    });
  });

  it("spends the one-shot at the claim, then denies the next call", async () => {
    const policy = createInMemoryAgentAuthorizer();
    await policy.allow(CHAT, WEB, { kind: "once" });
    const first = { capability: WEB, invocationId: "call-1", subject: CHAT };

    const decision = await policy.authorizer.decide(first);
    await expect(
      policy.authorizer.claim(first, decision)
    ).resolves.toMatchObject({ kind: "authorized" });

    await expect(policy.authorizer.decide(first)).resolves.toMatchObject({
      kind: "requires-approval",
    });
  });

  /** A replayed continuation re-runs `execute` with the same `toolCallId`. */
  it("lets the spending invocation replay its own claim", async () => {
    const policy = createInMemoryAgentAuthorizer();
    await policy.allow(CHAT, WEB, { kind: "once" });
    const request = { capability: WEB, invocationId: "call-1", subject: CHAT };

    const decision = await policy.authorizer.decide(request);
    await policy.authorizer.claim(request, decision);

    await expect(
      policy.authorizer.claim(request, decision)
    ).resolves.toMatchObject({ kind: "authorized" });
  });

  it("refuses a second invocation the same one-shot authority", async () => {
    const policy = createInMemoryAgentAuthorizer();
    await policy.allow(CHAT, WEB, { kind: "once" });
    const first = { capability: WEB, invocationId: "call-1", subject: CHAT };
    const second = { capability: WEB, invocationId: "call-2", subject: CHAT };

    const decision = await policy.authorizer.decide(first);
    await policy.authorizer.claim(first, decision);

    await expect(
      policy.authorizer.claim(second, decision)
    ).resolves.toMatchObject({ kind: "denied" });
  });

  it("denies at the effect boundary when authority was revoked mid-call", async () => {
    const policy = createInMemoryAgentAuthorizer();
    await policy.allow(CHAT, WEB);
    const request = { capability: WEB, invocationId: "call-1", subject: CHAT };

    const decision = await policy.authorizer.decide(request);
    await policy.revoke(CHAT, WEB);

    await expect(
      policy.authorizer.claim(request, decision)
    ).resolves.toMatchObject({ kind: "denied" });
  });

  it("refuses an unresolved approval that reaches the effect boundary", async () => {
    const policy = createInMemoryAgentAuthorizer();
    const request = { capability: WEB, invocationId: "call-1", subject: CHAT };

    const decision = await policy.authorizer.decide(request);
    expect(decision).toMatchObject({ kind: "requires-approval" });
    await expect(
      policy.authorizer.claim(request, decision)
    ).resolves.toMatchObject({ kind: "denied" });
  });
});

describe("resolveApproval", () => {
  it("persists a preset-scoped Grant for an always answer", async () => {
    const policy = createInMemoryAgentAuthorizer();
    const request = { capability: WEB, invocationId: "call-1", subject: CHAT };

    await policy.authorizer.resolveApproval(request, {
      approved: true,
      lifetime: "persistent",
    });

    await expect(
      policy.authorizer.decide({ ...request, invocationId: "call-2" })
    ).resolves.toMatchObject({ kind: "allow", source: "grant" });
    // Another preset answering the same question is a separate decision.
    await expect(
      policy.authorizer.decide({
        capability: WEB,
        invocationId: "call-3",
        subject: CANVAS,
      })
    ).resolves.toMatchObject({ kind: "requires-approval" });
  });

  /** A one-time answer is authority for this call, not a persisted decision. */
  it("writes nothing durable for a once answer", async () => {
    const policy = createInMemoryAgentAuthorizer();
    const request = { capability: WEB, invocationId: "call-1", subject: CHAT };

    await expect(
      policy.authorizer.resolveApproval(request, { approved: true })
    ).resolves.toEqual({ kind: "allow", source: "approval" });
    await expect(
      policy.authorizer.decide({ ...request, invocationId: "call-2" })
    ).resolves.toMatchObject({ kind: "requires-approval" });
  });

  it("leaves no authority behind when the human refuses", async () => {
    const policy = createInMemoryAgentAuthorizer();
    const request = { capability: WEB, invocationId: "call-1", subject: CHAT };

    await expect(
      policy.authorizer.resolveApproval(request, { approved: false })
    ).resolves.toMatchObject({ kind: "deny", source: "approval" });
    await expect(
      policy.authorizer.decide({ ...request, invocationId: "call-2" })
    ).resolves.toMatchObject({ kind: "requires-approval" });
  });
});
