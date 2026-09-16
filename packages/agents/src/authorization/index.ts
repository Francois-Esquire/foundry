/**
 * Agent authorization: this package's capability vocabulary, bound onto the
 * shared authorization mechanic in `@foundry/lib/config/authorization`.
 *
 * The split is deliberate. Config owns the *mechanism* — the Authorizer, the
 * affirmative Grant model, the Policy tiers — and knows no vocabulary, so a
 * module kernel or a CLI can reuse it without inheriting agent concepts. This
 * module owns what a capability *is* (`web.fetch`, `fs.read`, `mcp.tool`,
 * `domain.command`, `tool.call`), how it is addressed, and which kind fails
 * closed.
 */

/**
 * Re-exported so a host binds one import, not two, when composing authority.
 *
 * This entry is renderer-importable — a host's approval UI imports
 * `explainCapability` from it — so it re-exports only what stays pure.
 * `addressDigest` needs `node:crypto` and is reached at
 * `@foundry/lib/config/authorization/digest` by the main-process code that mints
 * storage keys.
 */
export type {
  ApprovalResolution,
  AuthorizationClaim,
  AuthorizationDenyRule,
  AuthorizationMode,
  Grant,
  GrantClaim,
  GrantInput,
  GrantLifetime,
  GrantProvenance,
} from "@foundry/lib/config/authorization";
export {
  encodeAddress,
  GrantClaimError,
} from "@foundry/lib/config/authorization";

export type {
  AgentAuthorizationDecision,
  AgentAuthorizationPolicy,
  AgentAuthorizationPolicySource,
  AgentAuthorizationRequest,
  AgentAuthorizer,
  AgentGrantRepository,
  AgentGrantSpecification,
  AgentSubject,
  CreateAgentAuthorizerOptions,
  InMemoryAgentAuthorizer,
} from "./authorization";
export {
  AGENT_ASK_BY_DEFAULT,
  AGENT_FAIL_CLOSED_KINDS,
  AGENT_SUBJECT_NAMESPACE,
  agentAddressing,
  agentCapabilityAddress,
  agentFailClosedReason,
  agentSubject,
  createAgentAuthorizer,
  createInMemoryAgentAuthorizer,
} from "./authorization";
export type {
  Capability,
  CapabilityExplanation,
  CapabilityKind,
  CommandAuthorityDefinition,
  CommandEffect,
  CommandSignature,
  CommandTarget,
  DomainCommandCapability,
  ToolSource,
} from "./capability";
export {
  classifyCommandCapability,
  describeCapability,
  explainCapability,
} from "./capability";
