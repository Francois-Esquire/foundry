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
// biome-ignore lint/performance/noBarrelFile: This is the exported @foundry/agents/authorization public API.
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
  MemoryAgentAuthorizer,
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
  createMemoryAgentAuthorizer,
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
export { agentSubjectSchema, capabilitySchema } from "./schema";
