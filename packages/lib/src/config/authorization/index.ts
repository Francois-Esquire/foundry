/**
 * Generic capability authorization: one Authorizer, one affirmative Grant
 * model, one Decision vocabulary.
 *
 * This module owns the *mechanism* and knows no host vocabulary. It never
 * learns that a Capability might be a filesystem read, an MCP tool, or a module
 * command — a host declares its own Subject and Capability types and supplies
 * the adapter that projects them onto an address. That is what lets one
 * mechanism serve an agent harness, a module kernel, and a CLI without any of
 * them inheriting the others' concepts.
 *
 * The vocabulary, kept distinct on purpose:
 *
 * - **Subject** — the durable identity authority belongs to.
 * - **Capability** — a host-owned description of one privileged operation. It
 *   describes what may be attempted; it is not authority.
 * - **Grant** — affirmative authority for one Subject to exercise one
 *   Capability, with a lifetime and provenance.
 * - **Profile** — declarative configuration: authored, issued to nobody.
 * - **Certificate** — a Profile issued to one Subject by a trusted host;
 *   versioned and revocable.
 * - **Policy** — the rules used when exact authority does not settle a request.
 * - **Authorizer** — the manager that combines all of the above into one
 *   Decision.
 * - **Approval** — a human's resolution of one unresolved Decision.
 *
 * Authorization decides; execution waits. There is no suspend port here and no
 * workflow import: the Authorizer returns `requires-approval`, and a
 * composition-layer adapter is what turns that into an ExecutionEngine
 * Suspension.
 *
 * This barrel is renderer-importable — a host's approval UI reaches the
 * vocabulary through it, and an unbundled ESM graph evaluates every re-export.
 * Nothing here may import a node builtin, directly or transitively. The one
 * module that needs one is `./digest`, deliberately left off this barrel.
 */

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
  InMemoryCertificateRepositoryOptions,
  InMemoryGrantRepositoryOptions,
} from "./memory";
export {
  createInMemoryCertificateRepository,
  createInMemoryGrantRepository,
} from "./memory";
export type {
  AuthorizationDenyRule,
  AuthorizationMode,
  AuthorizationPolicy,
  AuthorizationPolicySource,
} from "./policy";
export { resolvePolicy } from "./policy";
