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

export interface AuthorizationRequest<S extends AuthorizationSubject, C> {
  readonly capability: C;
  readonly context?: unknown;
  readonly invocationId: string;
  readonly scopeId?: string;
  readonly subject: S;
}

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

export type AuthorizationClaim =
  | {
      readonly kind: "authorized";
      readonly invocationId: string;
      readonly grant?: GrantClaim;
    }
  | { readonly kind: "denied"; readonly reason: string };

export interface ApprovalResolution {
  readonly approved: boolean;
  readonly lifetime?: "once" | "session" | "persistent";
  readonly reason?: string;
}

export interface Authorizer<S extends AuthorizationSubject, C> {
  claim: (
    request: AuthorizationRequest<S, C>,
    decision: AuthorizationDecision
  ) => Promise<AuthorizationClaim>;
  decide: (
    request: AuthorizationRequest<S, C>
  ) => Promise<AuthorizationDecision>;
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
  readonly addressing: AuthorizationAddressing<S, C>;
  readonly events?: AuthorizationEventSink<S, C>;
  readonly failClosedReason?: (capability: C) => string;
  readonly grants: GrantRepository<S, C>;
  readonly kindOf: (capability: C) => K;
  readonly now?: () => number;
  readonly policy:
    | AuthorizationPolicy<S, C, K>
    | AuthorizationPolicySource<S, C, K>;
}

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
      if (decision.kind === "deny") {
        return { kind: "denied", reason: decision.reason };
      }
      if (decision.kind === "requires-approval") {
        return {
          kind: "denied",
          reason: "Authorization is unresolved; approval was never obtained.",
        };
      }

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
      const policy = resolvePolicy(policyOption);
      const at = now();
      const address = addressing.addressOf(request.subject, request.capability);
      const key = encodeAddress(address);

      const denied = exactDeny(policy, key);
      if (denied) {
        return denied;
      }

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

      const kind = kindOf(request.capability);
      const kindMode = policy.byKind?.[kind];
      if (kindMode !== undefined) {
        return decisionForMode(kindMode, "kind-policy");
      }

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

    async resolveApproval(
      request: AuthorizationRequest<S, C>,
      resolution: ApprovalResolution
    ): Promise<AuthorizationDecision> {
      const policy = resolvePolicy(policyOption);
      const at = now();
      const address = addressing.addressOf(request.subject, request.capability);
      const key = encodeAddress(address);

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
