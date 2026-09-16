/**
 * The Authorizer: the one decision algorithm.
 *
 * It combines a Subject, a Capability, the live Grants at their address, and
 * the Policy rules, and returns exactly one Decision. Everything that used to
 * be a second evaluator — the module in-memory policy, the renderer's blocking
 * broker, the gated policy state machine — is this function.
 *
 * The load-bearing split is {@link Authorizer.decide} versus
 * {@link Authorizer.claim}. A one-shot Grant is consumed by being taken, and
 * the agent path evaluates every tool call twice by design (once in the AI
 * SDK's `needsApproval` predicate, once defensively before executing) so that a
 * replayed approval is not mistaken for a fabricated one. Those two facts are
 * individually fine and jointly a bug: an evaluation that consumes authority
 * would spend a one-shot Grant before the real invocation ever ran. So `decide`
 * is repeatable and consumes nothing, and `claim` runs once at the effect
 * boundary and is idempotent by invocation.
 */

import type { AuthorizationAddressing, AuthorizationSubject } from "./address";
import { encodeAddress } from "./address";
import type { AuthorizationEventSink } from "./events";
import type {
  Grant,
  GrantClaim,
  GrantLifetime,
  GrantRepository,
} from "./grant";
import type {
  AuthorizationMode,
  AuthorizationPolicy,
  AuthorizationPolicySource,
} from "./policy";
import { resolvePolicy } from "./policy";

/**
 * One attempt to exercise one Capability.
 *
 * `invocationId` must be stable across replays of the same call — it is what
 * makes a claim idempotent. `scopeId` is the host-issued session or workspace
 * scope; without it, session authority can neither be granted nor honored.
 */
export interface AuthorizationRequest<S extends AuthorizationSubject, C> {
  readonly capability: C;
  readonly context?: unknown;
  readonly invocationId: string;
  readonly scopeId?: string;
  readonly subject: S;
}

/**
 * The answer. `requires-approval` names the authorization result without
 * pretending a wait has begun — this module owns no suspend port, and a
 * composition adapter is what turns this into an ExecutionEngine Suspension.
 */
export type AuthorizationDecision =
  | {
      readonly kind: "allow";
      readonly source: "grant" | "approval" | "kind-policy" | "global-policy";
      readonly grantId?: string;
      readonly grantRevision?: number;
    }
  | {
      readonly kind: "deny";
      readonly source: "policy" | "approval";
      readonly reason: string;
    }
  | { readonly kind: "requires-approval" };

/** The effect boundary's answer: run, or do not. */
export type AuthorizationClaim =
  | {
      readonly kind: "authorized";
      readonly invocationId: string;
      readonly grant?: GrantClaim;
    }
  | { readonly kind: "denied"; readonly reason: string };

/**
 * A human's resolution of one unresolved Decision.
 *
 * An approved resolution with no `lifetime` means `"once"`. A `"session"`
 * resolution is invalid without the request's `scopeId`, because session
 * authority that cannot name its session is persistent authority wearing a
 * shorter name.
 */
export interface ApprovalResolution {
  readonly approved: boolean;
  readonly lifetime?: "once" | "session" | "persistent";
  readonly reason?: string;
}

export interface Authorizer<S extends AuthorizationSubject, C> {
  /** Runs immediately before the effect; consumes one-shot authority atomically. */
  claim: (
    request: AuthorizationRequest<S, C>,
    decision: AuthorizationDecision
  ) => Promise<AuthorizationClaim>;
  /** Repeatable and non-consuming. Never waits for a human. */
  decide: (
    request: AuthorizationRequest<S, C>
  ) => Promise<AuthorizationDecision>;
  /** Turn a human's answer into a Decision bound to this same invocation. */
  resolveApproval: (
    request: AuthorizationRequest<S, C>,
    resolution: ApprovalResolution
  ) => Promise<AuthorizationDecision>;
}

export interface CreateAuthorizerOptions<
  S extends AuthorizationSubject,
  C,
  K extends string = string,
> {
  /** The host adapter that projects its Subject and Capability onto an address. */
  readonly addressing: AuthorizationAddressing<S, C>;
  readonly events?: AuthorizationEventSink<S, C>;
  /** Reason attached to a fail-closed denial, given the offending Capability. */
  readonly failClosedReason?: (capability: C) => string;
  readonly grants: GrantRepository<S, C>;
  /** Project a Capability onto the kind its Policy mode is looked up under. */
  readonly kindOf: (capability: C) => K;
  /** Injected so expiry and lifetime are testable. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** A fixed rule set, or a live source read once per decision. */
  readonly policy:
    | AuthorizationPolicy<S, C, K>
    | AuthorizationPolicySource<S, C, K>;
}

/**
 * Rank live Grants so a durable one is preferred over a one-shot.
 *
 * When a Subject holds both a persistent Grant and a leftover one-shot for the
 * same Capability, taking the one-shot would spend it for nothing. Durable
 * authority is used first and the one-shot stays available for a call that
 * actually needs it.
 */
function lifetimeRank(grant: Grant<AuthorizationSubject, unknown>): number {
  // biome-ignore lint/style/useDefaultSwitchClause: All members of the discriminated union are handled; keep TypeScript exhaustiveness checking.
  switch (grant.lifetime.kind) {
    case "persistent":
      return 0;
    case "session":
      return 1;
    case "once":
      return 2;
  }
}

function decisionForMode(
  mode: AuthorizationMode,
  source: "kind-policy" | "global-policy"
): AuthorizationDecision {
  // biome-ignore lint/style/useDefaultSwitchClause: All members of the discriminated union are handled; keep TypeScript exhaustiveness checking.
  switch (mode) {
    case "allow":
      return { kind: "allow", source };
    case "deny":
      return {
        kind: "deny",
        reason: `Denied by ${source === "kind-policy" ? "capability kind" : "global"} policy.`,
        source: "policy",
      };
    case "ask":
      return { kind: "requires-approval" };
  }
}

export function createAuthorizer<
  S extends AuthorizationSubject,
  C,
  K extends string = string,
>(options: CreateAuthorizerOptions<S, C, K>): Authorizer<S, C> {
  const {
    addressing,
    grants,
    policy: policyOption,
    kindOf,
    now = Date.now,
    events,
    failClosedReason,
  } = options;

  /**
   * The exact-deny tier. Rules are addressed through the same host adapter as
   * the request, so "the same Subject and Capability" means one thing in this
   * module and not two.
   */
  function exactDeny(
    policy: AuthorizationPolicy<S, C, K>,
    key: string
  ): AuthorizationDecision | undefined {
    for (const rule of policy.exactDenies ?? []) {
      const ruleKey = encodeAddress(
        addressing.addressOf(rule.subject, rule.capability)
      );
      if (ruleKey === key) {
        return { kind: "deny", reason: rule.reason, source: "policy" };
      }
    }
    return undefined;
  }

  /**
   * A session Grant is only authority inside the scope it was issued for.
   * `find` cannot apply this — it does not see the request — so it happens here,
   * and a request with no `scopeId` can never match a session Grant.
   */
  function usable(
    grant: Grant<S, C>,
    request: AuthorizationRequest<S, C>
  ): boolean {
    return (
      grant.lifetime.kind !== "session" ||
      grant.lifetime.scopeId === request.scopeId
    );
  }

  return {
    async claim(
      request: AuthorizationRequest<S, C>,
      decision: AuthorizationDecision
    ): Promise<AuthorizationClaim> {
      // Anything short of an allow reaching the effect boundary is a denial,
      // including an unresolved `requires-approval` — a caller that skipped the
      // approval step must not get the benefit of the doubt.
      if (decision.kind === "deny") {
        return { kind: "denied", reason: decision.reason };
      }
      if (decision.kind === "requires-approval") {
        return {
          kind: "denied",
          reason: "Authorization is unresolved; approval was never obtained.",
        };
      }

      // An allow from Policy names no Grant, so there is nothing to consume.
      if (decision.grantId === undefined) {
        return { invocationId: request.invocationId, kind: "authorized" };
      }

      const address = addressing.addressOf(request.subject, request.capability);
      try {
        const grant = await grants.claimOnce(
          decision.grantId,
          request.invocationId
        );
        events?.emit({
          address,
          at: now(),
          capability: request.capability,
          grantId: grant.grantId,
          invocationId: grant.invocationId,
          kind: "claimed",
        });
        return {
          grant,
          invocationId: request.invocationId,
          kind: "authorized",
        };
      } catch (error) {
        // Authority can be revoked between deciding and claiming. Losing that
        // race is a denial, not a crash.
        const reason =
          error instanceof Error
            ? error.message
            : "Authority could not be claimed.";
        events?.emit({
          address,
          at: now(),
          capability: request.capability,
          grantId: decision.grantId,
          invocationId: request.invocationId,
          kind: "denied",
          reason,
        });
        return { kind: "denied", reason };
      }
    },
    async decide(
      request: AuthorizationRequest<S, C>
    ): Promise<AuthorizationDecision> {
      // Snapshot the whole Policy BEFORE the first await. The deny tier and the
      // mode tiers must agree with each other; reading them either side of the
      // repository lookup would let a settings write land mid-decision, and the
      // same call could then answer from two different configurations.
      const policy = resolvePolicy(policyOption);
      const at = now();
      const address = addressing.addressOf(request.subject, request.capability);
      const key = encodeAddress(address);

      // Tier 1: an exact host-configured denial beats any authority.
      const denied = exactDeny(policy, key);
      if (denied) {
        return denied;
      }

      // Tier 2: any live Grant, whoever issued it. Revoked and expired
      // authority is already absent; session authority must match this scope.
      const live = (await grants.find(address, at)).filter((grant) =>
        usable(grant, request)
      );
      if (live.length > 0) {
        const [best] = [...live].sort(
          (a, b) => lifetimeRank(a) - lifetimeRank(b)
        );
        if (best) {
          return {
            grantId: best.id,
            grantRevision: best.revision,
            kind: "allow",
            source: "grant",
          };
        }
      }

      // Tier 3: this Capability kind's configured mode.
      const kind = kindOf(request.capability);
      const kindMode = policy.byKind?.[kind];
      if (kindMode !== undefined) {
        return decisionForMode(kindMode, "kind-policy");
      }

      // Tier 4: the global mode — unreachable for fail-closed kinds.
      if (policy.failClosed?.includes(kind)) {
        return {
          kind: "deny",
          reason:
            failClosedReason?.(request.capability) ??
            `No policy classification for "${kind}"; unclassified capabilities fail closed.`,
          source: "policy",
        };
      }
      return decisionForMode(policy.global, "global-policy");
    },

    // biome-ignore lint/suspicious/useAwait: Keep synchronous failures as rejected promises under the asynchronous public contract.
    async resolveApproval(
      request: AuthorizationRequest<S, C>,
      resolution: ApprovalResolution
    ): Promise<AuthorizationDecision> {
      const policy = resolvePolicy(policyOption);
      const at = now();
      const address = addressing.addressOf(request.subject, request.capability);
      const key = encodeAddress(address);

      // Defence in depth on replay. The normal flow re-runs `decide` before a
      // stored resolution is honored, so a deny added while the call was parked
      // is already caught there; this makes it true even for a caller that
      // resolves an approval without deciding again.
      const denied = exactDeny(policy, key);
      if (denied) {
        return denied;
      }

      if (!resolution.approved) {
        const reason = resolution.reason ?? "Denied by the approver.";
        events?.emit({
          address,
          at,
          capability: request.capability,
          invocationId: request.invocationId,
          kind: "denied",
          reason,
        });
        return { kind: "deny", reason, source: "approval" };
      }

      const lifetime = resolution.lifetime ?? "once";

      // A one-time approval is authority for this invocation only, carried by
      // the durable Suspension resolution that produced it. Writing a Grant for
      // it would create authority that outlives the call it was given for.
      if (lifetime === "once") {
        events?.emit({
          address,
          at,
          capability: request.capability,
          invocationId: request.invocationId,
          kind: "approved",
        });
        return { kind: "allow", source: "approval" };
      }

      async function issue(
        grantLifetime: GrantLifetime
      ): Promise<AuthorizationDecision> {
        const grant = await grants.issue({
          address,
          capability: request.capability,
          lifetime: grantLifetime,
          provenance: "human",
        });
        events?.emit({
          address,
          at,
          capability: request.capability,
          grantId: grant.id,
          invocationId: request.invocationId,
          kind: "approved",
        });
        return {
          grantId: grant.id,
          grantRevision: grant.revision,
          kind: "allow",
          source: "approval",
        };
      }

      if (lifetime === "persistent") {
        return issue({ kind: "persistent" });
      }

      const { scopeId } = request;
      if (scopeId === undefined) {
        return {
          kind: "deny",
          reason:
            "A session approval requires the request's host-issued scopeId.",
          source: "approval",
        };
      }
      return issue({ kind: "session", scopeId });
    },
  };
}
