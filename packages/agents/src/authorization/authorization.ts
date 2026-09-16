/**
 * The agent vocabulary bound onto the shared authorization mechanic in
 * `@foundry/lib/config/authorization`.
 *
 * Nothing here re-implements a decision. The Authorizer, the Grant model, and
 * the Policy tiers all live in config and know no agent concepts; what lives
 * here is the projection — what an agent Subject is, how this package's
 * {@link Capability} union becomes a versioned {@link CapabilityAddress}, and
 * which capability kind fails closed.
 *
 * The address is what fixes the under-namespacing the old `capabilityKey` had.
 * That key hashed the capability payload alone, so two agent presets exposing
 * the same tool name shared authority outright. Here every lookup carries the
 * preset as its Subject, so they cannot.
 */

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
  createInMemoryGrantRepository,
} from "@foundry/lib/config/authorization";

import type { Capability, CapabilityKind } from "./capability";

/** Every agent Subject lives under one namespace, so an id can never be read as
 *  a module installation's. */
export const AGENT_SUBJECT_NAMESPACE = "agent";

/**
 * The durable identity agent authority belongs to: one agent preset.
 *
 * `id` is `AgentSpec.id`. `generation` is the preset's revision — it becomes
 * the Subject `version`, so re-authoring a preset retires every Grant issued to
 * the previous one rather than silently inheriting it. Omit it for a preset
 * with no generations.
 */
export interface AgentSubject {
  readonly id: string;
  readonly namespace: typeof AGENT_SUBJECT_NAMESPACE;
  readonly version?: number;
}

export function agentSubject(id: string, generation?: number): AgentSubject {
  return {
    id,
    namespace: AGENT_SUBJECT_NAMESPACE,
    ...(generation === undefined ? {} : { version: generation }),
  };
}

/**
 * The capability *schema* version for kinds whose shape this package owns.
 * Bumping it means the shape of what is being granted changed, so prior Grants
 * must not carry over. `domain.command` is the exception: it carries the
 * command catalog's own version, which is exactly this concept already.
 */
const AGENT_CAPABILITY_VERSION = 1;

/**
 * Project one {@link Capability} onto its versioned address.
 *
 * `id` is the capability's primary named target; every remaining narrowing
 * field goes into `constraintsDigest`. That field is a readable canonical
 * string rather than a hash on purpose — `addressDigest` already provides the
 * fixed-width index, so keeping the constraints legible costs nothing and keeps
 * a stored address inspectable and migratable. `JSON.stringify` of an array of
 * strings is injective, so two different constraint sets cannot encode alike.
 */
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
        // The canonical realpath is part of the address, not incidental:
        // re-pointing a project root must retire the grant, not inherit it.
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
        // Stringified rather than joined: a domain containing the separator
        // would otherwise collide with a different domain/command pair.
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
  }
}

/** The one way an agent address is produced. */
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

/**
 * `tool.call` is the one capability kind with no authority vocabulary of its
 * own. It must not reach the global tier: with no Grant and no explicit
 * `tool.call` mode it fails closed rather than inheriting a blanket `"allow"`
 * meant for kinds the Policy understands.
 */
export const AGENT_FAIL_CLOSED_KINDS: readonly CapabilityKind[] = ["tool.call"];

export function agentFailClosedReason(capability: Capability): string {
  const tool =
    capability.kind === "tool.call" ? capability.tool : capability.kind;
  return `No policy classification for tool "${tool}"; unclassified tool calls fail closed.`;
}

/**
 * The safe posture for a host with no persisted configuration: every kind asks
 * a human — classified kinds through `global`, and the fail-closed `tool.call`
 * through an explicit `byKind` entry.
 *
 * Naming `tool.call` here is the sanctioned way to say what an unclassified
 * tool should do: without it the kind never reaches the global tier and every
 * unclassified tool is denied without a human ever seeing it. `"ask"` is the
 * safe answer rather than `"allow"` or the silent deny, and it is the behavior
 * every capability had before this mechanic existed.
 */
export const AGENT_ASK_BY_DEFAULT: AgentAuthorizationPolicy = {
  byKind: { "tool.call": "ask" },
  failClosed: AGENT_FAIL_CLOSED_KINDS,
  global: "ask",
};

export interface CreateAgentAuthorizerOptions {
  readonly grants: AgentGrantRepository;
  /** Injected so expiry and lifetime are testable. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** A fixed rule set, or a live source read once per decision. */
  readonly policy?: AgentAuthorizationPolicy | AgentAuthorizationPolicySource;
}

/**
 * Bind the shared Authorizer to this package's vocabulary.
 *
 * {@link AGENT_FAIL_CLOSED_KINDS} is merged into whatever Policy the host
 * supplies rather than left to it. Which kinds carry no authority vocabulary is
 * a fact about this Capability union, not a host preference — a host that
 * forgot the field would silently hand every unclassified tool its blanket
 * global mode, which is the exact failure the exclusion exists to prevent.
 */
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
    policy:
      "current" in configured
        ? { current: () => withFailClosed(configured.current()) }
        : withFailClosed(configured),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export interface InMemoryAgentAuthorizer {
  /** Issue authority the way a host would, without hand-building an address. */
  allow(
    subject: AgentSubject,
    capability: Capability,
    lifetime?: GrantLifetime
  ): Promise<void>;
  readonly authorizer: AgentAuthorizer;
  readonly grants: AgentGrantRepository;
  /** Retire every live Grant at one address. */
  revoke(subject: AgentSubject, capability: Capability): Promise<void>;
}

/**
 * Reference composition over in-memory storage — what tests reach for when they
 * need a working agent Authorizer.
 *
 * The repository is returned alongside the Authorizer because issuing and
 * revoking authority is a repository operation, not an Authorizer one.
 */
export function createInMemoryAgentAuthorizer(
  options: Omit<CreateAgentAuthorizerOptions, "grants"> = {}
): InMemoryAgentAuthorizer {
  const now = options.now ?? Date.now;
  const grants = createInMemoryGrantRepository<AgentSubject, Capability>({
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
