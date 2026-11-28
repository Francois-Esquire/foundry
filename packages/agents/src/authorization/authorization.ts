import type {
  AccessRequest,
  AuthorizationOptions,
  JsonPrimitive,
  Principal,
  PrincipalMatcher,
  Scope,
} from "@foundry/authorization";
import { Authorization } from "@foundry/authorization";
import { MemoryAuthorizationStore } from "@foundry/authorization/store/memory";
import type { JsonValue } from "@foundry/lib/json";

import type { Capability } from "./capability";

export const AGENT_SUBJECT_NAMESPACE = "agent";

export const HOST_APPROVER: Principal = {
  id: "host",
  kind: "human",
};

export interface AgentSubject {
  readonly id: string;
  readonly namespace: typeof AGENT_SUBJECT_NAMESPACE;
  readonly version?: number;
}

export function agentSubject(id: string, generation?: number): AgentSubject {
  return {
    id,
    namespace: AGENT_SUBJECT_NAMESPACE,
    version: generation,
  };
}

export function agentPrincipal(
  id: string,
  generation?: number,
  attributes?: Readonly<Record<string, JsonValue>>
): Principal {
  return {
    ...(attributes === undefined ? {} : { attributes }),
    id,
    kind: AGENT_SUBJECT_NAMESPACE,
    ...(generation === undefined ? {} : { version: String(generation) }),
  };
}

export function agentPrincipalMatcher(
  id: string,
  generation?: number
): PrincipalMatcher {
  return {
    kind: "exact",
    principal: {
      id,
      kind: AGENT_SUBJECT_NAMESPACE,
      ...(generation === undefined ? {} : { version: String(generation) }),
    },
  };
}

export function agentSubjectToPrincipal(
  subject: AgentSubject,
  attributes?: Readonly<Record<string, JsonValue>>
): Principal {
  return agentPrincipal(subject.id, subject.version, attributes);
}

export type ApprovalLifetime = "once" | "session" | "persistent";

export interface ApprovalResolution {
  readonly approved: boolean;
  readonly approver?: Principal;
  readonly lifetime?: ApprovalLifetime;
  readonly reason?: string;
}

export function extractCommandInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || !("command" in input)) {
    return undefined;
  }
  return typeof input.command === "string" ? input.command : undefined;
}

function describeCapability(capability: Capability): {
  readonly attributes?: Readonly<Record<string, JsonPrimitive>>;
  readonly target: string;
} {
  switch (capability.kind) {
    case "web.fetch":
      return { target: capability.domain };
    case "mcp.tool":
      return {
        attributes: { tool: capability.tool },
        target: capability.serverId,
      };
    case "fs.read":
      return {
        attributes: { root: capability.root },
        target: capability.projectId,
      };
    case "domain.command":
      return {
        attributes: {
          effect: capability.effect,
          projectId: capability.target.projectId,
          scope: capability.target.scope,
        },
        target: JSON.stringify([
          capability.domain,
          capability.command.id,
          capability.command.version,
        ]),
      };
    case "tool.call":
      return {
        attributes: { source: capability.source },
        target: capability.tool.toLowerCase(),
      };
    default:
      return undefined as never;
  }
}

export function capabilityToScope(capability: Capability): Scope {
  const { attributes, target } = describeCapability(capability);
  return {
    action: capability.kind,
    ...(attributes === undefined
      ? {}
      : {
          constraints: Object.fromEntries(
            Object.entries(attributes).map(([key, value]) => [
              key,
              { op: "eq", value } as const,
            ])
          ),
        }),
    target: { kind: "exact", value: target },
  };
}

export interface CapabilityAccessRequestArgs {
  readonly agentGeneration?: number;
  readonly agentId: string;
  readonly capability: Capability;
  readonly input?: unknown;
  readonly invocationId?: string;
  readonly principalAttributes?: Readonly<Record<string, JsonValue>>;
  readonly sessionId?: string;
}

export function capabilityToAccessRequest(
  args: CapabilityAccessRequestArgs
): AccessRequest {
  const command = extractCommandInput(args.input);
  const principalAttributes: Record<string, JsonValue> = {
    ...args.principalAttributes,
    agentId: args.agentId,
    ...(args.agentGeneration === undefined
      ? {}
      : { agentGeneration: args.agentGeneration }),
    ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
  };
  const principal = agentPrincipal(
    args.agentId,
    args.agentGeneration,
    principalAttributes
  );
  const { attributes: baseAttributes, target } = describeCapability(
    args.capability
  );

  const attributes: Record<string, JsonValue> | undefined =
    baseAttributes !== undefined || command !== undefined
      ? {
          ...baseAttributes,
          ...(command === undefined ? {} : { command }),
        }
      : undefined;

  return {
    action: args.capability.kind,
    ...(attributes === undefined ? {} : { attributes }),
    ...(args.invocationId === undefined
      ? {}
      : { invocationId: args.invocationId }),
    principal,
    ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
    target,
  };
}

export function createMemoryAuthorization(
  options: Omit<AuthorizationOptions, "store"> = {}
): Authorization {
  return new Authorization({
    ...options,
    store: new MemoryAuthorizationStore(),
  });
}
