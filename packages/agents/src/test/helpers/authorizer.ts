import type { Authorization } from "@foundry/authorization";
import {
  agentPrincipal,
  agentPrincipalMatcher,
  capabilityToScope,
  createMemoryAuthorization,
  HOST_APPROVER,
} from "../../authorization/authorization";
import type { Capability } from "../../authorization/capability";

const ALL_CAPABILITY_ACTIONS = [
  "web.fetch",
  "mcp.tool",
  "fs.read",
  "domain.command",
  "tool.call",
] as const;

export async function createPermissiveAuthorization(
  options: {
    readonly agentGeneration?: number;
    readonly agentId?: string;
    readonly actions?: readonly string[];
  } = {}
): Promise<Authorization> {
  const authorization = createMemoryAuthorization();
  const holder =
    options.agentId === undefined
      ? ({ kind: "any" } as const)
      : agentPrincipalMatcher(options.agentId, options.agentGeneration);
  const requestedBy = agentPrincipal(
    options.agentId ?? "test",
    options.agentGeneration
  );
  for (const action of options.actions ?? ALL_CAPABILITY_ACTIONS) {
    await authorization.grant({
      canDelegate: true,
      holder,
      issuer: HOST_APPROVER,
      requestedBy,
      scope: { action, target: { kind: "any" } },
    });
  }
  return authorization;
}

export async function grantCapability(
  authorization: Authorization,
  agentId: string,
  capability: Capability,
  options: {
    readonly agentGeneration?: number;
    readonly canDelegate?: boolean;
    readonly sessionId?: string;
    readonly usesRemaining?: number;
  } = {}
) {
  return await authorization.grant({
    canDelegate: options.canDelegate ?? false,
    holder: agentPrincipalMatcher(agentId, options.agentGeneration),
    issuer: HOST_APPROVER,
    requestedBy: agentPrincipal(agentId, options.agentGeneration),
    scope: capabilityToScope(capability),
    ...(options.sessionId === undefined
      ? {}
      : { sessionId: options.sessionId }),
    ...(options.usesRemaining === undefined
      ? {}
      : { usesRemaining: options.usesRemaining }),
  });
}

export async function denyAction(
  authorization: Authorization,
  action: string,
  reason = `Denied ${action}.`
) {
  return await authorization.restrict({
    kind: "deny",
    reason,
    scope: { action, target: { kind: "any" } },
  });
}
