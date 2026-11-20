import type {
  AgentAuthorizationDecision,
  AgentAuthorizationRequest,
  AgentAuthorizer,
} from "../../authorization/authorization";

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
