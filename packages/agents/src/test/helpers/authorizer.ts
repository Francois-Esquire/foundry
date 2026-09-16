import type {
  AgentAuthorizationDecision,
  AgentAuthorizationRequest,
  AgentAuthorizer,
} from "../../authorization/index";

/**
 * An {@link AgentAuthorizer} whose decision is a plain function of the request.
 *
 * Holds no Grants, so `claim` succeeds for any allow and there is nothing to
 * consume — tests that care about one-shot consumption use
 * `createInMemoryAgentAuthorizer` instead. What this exists for is driving the
 * compiler through each decision branch without composing a repository.
 */
export function fakeAuthorizer(
  decide: (request: AgentAuthorizationRequest) => AgentAuthorizationDecision
): AgentAuthorizer {
  return {
    claim: (request, decision) =>
      Promise.resolve(
        decision.kind === "allow"
          ? { invocationId: request.invocationId, kind: "authorized" }
          : {
              kind: "denied",
              reason:
                decision.kind === "deny"
                  ? decision.reason
                  : "Authorization is unresolved; approval was never obtained.",
            }
      ),
    decide: (request) => Promise.resolve(decide(request)),
    resolveApproval: (_request, resolution) =>
      Promise.resolve(
        resolution.approved
          ? { kind: "allow", source: "approval" }
          : {
              kind: "deny",
              reason: resolution.reason ?? "Denied by the approver.",
              source: "approval",
            }
      ),
  };
}

/** The permissive authorizer, for tests that only need calls to go through. */
export function allowAllAuthorizer(): AgentAuthorizer {
  return fakeAuthorizer(() => ({ kind: "allow", source: "global-policy" }));
}
