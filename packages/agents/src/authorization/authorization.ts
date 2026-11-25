import type {
  AuthorizationAddressing,
  AuthorizationDecision,
  AuthorizationPolicy,
  AuthorizationPolicySource,
  AuthorizationRequest,
  Authorizer,
  CapabilityAddress,
  GrantLifetime,
  GrantRepository,
  GrantSpecification,
} from "@foundry/lib/config/authorization";

import {
  authorizationAddress,
  createAuthorizer,
  createMemoryGrantRepository,
} from "@foundry/lib/config/authorization";

import type { Capability, CapabilityKind } from "./capability";

export const AGENT_SUBJECT_NAMESPACE = "agent";

export interface AgentSubject {
  readonly id: string;
  readonly namespace: typeof AGENT_SUBJECT_NAMESPACE;
  readonly version?: number;
}

export function agentSubject(id: string, generation?: number): AgentSubject {
  return {
    id,
    namespace: AGENT_SUBJECT_NAMESPACE,
    version: generation,
  };
}

const AGENT_CAPABILITY_VERSION = 1;

export function agentCapabilityAddress(
  capability: Capability
): CapabilityAddress {
  switch (capability.kind) {
    case "web.fetch":
      return {
        id: capability.domain,
        namespace: capability.kind,
        version: AGENT_CAPABILITY_VERSION,
      };
    case "mcp.tool":
      return {
        constraintsDigest: JSON.stringify([capability.tool]),
        id: capability.serverId,
        namespace: capability.kind,
        version: AGENT_CAPABILITY_VERSION,
      };
    case "fs.read":
      return {
        constraintsDigest: JSON.stringify([capability.root]),
        id: capability.projectId,
        namespace: capability.kind,
        version: AGENT_CAPABILITY_VERSION,
      };
    case "domain.command":
      return {
        constraintsDigest: JSON.stringify([
          capability.effect,
          capability.target.projectId,
          capability.target.scope,
        ]),
        id: JSON.stringify([capability.domain, capability.command.id]),
        namespace: capability.kind,
        version: capability.command.version,
      };
    case "tool.call":
      return {
        constraintsDigest: JSON.stringify([capability.source]),
        id: capability.tool,
        namespace: capability.kind,
        version: AGENT_CAPABILITY_VERSION,
      };
    default:
      break;
  }
  return undefined as never;
}

export const agentAddressing: AuthorizationAddressing<
  AgentSubject,
  Capability
> = {
  addressOf: (subject, capability) =>
    authorizationAddress(subject, agentCapabilityAddress(capability)),
};

export type AgentAuthorizer = Authorizer<AgentSubject, Capability>;
export type AgentGrantRepository = GrantRepository<AgentSubject, Capability>;
export type AgentAuthorizationRequest = AuthorizationRequest<
  AgentSubject,
  Capability
>;
export type AgentAuthorizationDecision = AuthorizationDecision;
export type AgentAuthorizationPolicy = AuthorizationPolicy<
  AgentSubject,
  Capability,
  CapabilityKind
>;
export type AgentAuthorizationPolicySource = AuthorizationPolicySource<
  AgentSubject,
  Capability,
  CapabilityKind
>;
export type AgentGrantSpecification = GrantSpecification<Capability>;

export const AGENT_FAIL_CLOSED_KINDS: readonly CapabilityKind[] = ["tool.call"];

export function agentFailClosedReason(capability: Capability): string {
  const tool =
    capability.kind === "tool.call" ? capability.tool : capability.kind;
  return `No policy classification for tool "${tool}"; unclassified tool calls fail closed.`;
}

export const AGENT_ASK_BY_DEFAULT: AgentAuthorizationPolicy = {
  byKind: { "tool.call": "ask" },
  failClosed: AGENT_FAIL_CLOSED_KINDS,
  global: "ask",
};

export interface CreateAgentAuthorizerOptions {
  readonly grants: AgentGrantRepository;
  readonly now?: () => number;
  readonly policy?: AgentAuthorizationPolicy | AgentAuthorizationPolicySource;
}

export function createAgentAuthorizer(
  options: CreateAgentAuthorizerOptions
): AgentAuthorizer {
  const configured = options.policy ?? AGENT_ASK_BY_DEFAULT;
  const withFailClosed = (
    policy: AgentAuthorizationPolicy
  ): AgentAuthorizationPolicy => ({
    ...policy,
    failClosed: [
      ...AGENT_FAIL_CLOSED_KINDS,
      ...(policy.failClosed ?? []).filter(
        (kind) => !AGENT_FAIL_CLOSED_KINDS.includes(kind)
      ),
    ],
  });

  return createAuthorizer<AgentSubject, Capability, CapabilityKind>({
    addressing: agentAddressing,
    failClosedReason: agentFailClosedReason,
    grants: options.grants,
    kindOf: (capability) => capability.kind,
    now: options.now,
    policy:
      "current" in configured
        ? { current: () => withFailClosed(configured.current()) }
        : withFailClosed(configured),
  });
}

export interface MemoryAgentAuthorizer {
  allow(
    subject: AgentSubject,
    capability: Capability,
    lifetime?: GrantLifetime
  ): Promise<void>;
  readonly authorizer: AgentAuthorizer;
  readonly grants: AgentGrantRepository;
  revoke(subject: AgentSubject, capability: Capability): Promise<void>;
}

export function createMemoryAgentAuthorizer(
  options: Omit<CreateAgentAuthorizerOptions, "grants"> = {}
): MemoryAgentAuthorizer {
  const now = options.now ?? Date.now;
  const grants = createMemoryGrantRepository<AgentSubject, Capability>({
    now,
  });
  const authorizer = createAgentAuthorizer({ ...options, grants });

  return {
    async allow(subject, capability, lifetime = { kind: "persistent" }) {
      await grants.issue({
        address: agentAddressing.addressOf(subject, capability),
        capability,
        lifetime,
        provenance: "human",
      });
    },
    authorizer,
    grants,
    async revoke(subject, capability) {
      const address = agentAddressing.addressOf(subject, capability);
      const live = await grants.find(address, now());
      for (const grant of live) {
        await grants.revoke(grant.id);
      }
    },
  };
}
