export type {
  AuthorizationAddress,
  AuthorizationAddressing,
  AuthorizationSubject,
  CapabilityAddress,
} from "./address";
// biome-ignore lint/performance/noBarrelFile: This is a declared package entry point; preserve its public exports.
export {
  AUTHORIZATION_ADDRESS_SCHEMA,
  AUTHORIZATION_ADDRESS_VERSION,
  authorizationAddress,
  encodeAddress,
} from "./address";
export type {
  ApprovalResolution,
  AuthorizationClaim,
  AuthorizationDecision,
  AuthorizationRequest,
  Authorizer,
  CreateAuthorizerOptions,
} from "./authorizer";
export { createAuthorizer } from "./authorizer";

export type {
  AuthorizationCertificate,
  AuthorizationProfile,
  CertificateForProfileOptions,
  CertificateRepository,
  GrantSpecification,
} from "./certificate";
export { CertificateVersionError, certificateForProfile } from "./certificate";
export type {
  AuthorizationEvent,
  AuthorizationEventKind,
  AuthorizationEventSink,
} from "./events";
export type {
  Grant,
  GrantClaim,
  GrantInput,
  GrantLifetime,
  GrantProvenance,
  GrantRepository,
} from "./grant";
export { GrantClaimError, GrantRevisionError } from "./grant";
export type {
  MemoryCertificateRepositoryOptions,
  MemoryGrantRepositoryOptions,
} from "./memory";
export {
  createMemoryCertificateRepository,
  createMemoryGrantRepository,
} from "./memory";
export type {
  AuthorizationDenyRule,
  AuthorizationMode,
  AuthorizationPolicy,
  AuthorizationPolicySource,
} from "./policy";
export { resolvePolicy } from "./policy";
