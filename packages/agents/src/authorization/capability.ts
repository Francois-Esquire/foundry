import type {
  Capability,
  CommandAuthorityDefinition,
  DomainCommandCapability,
  ToolSource,
} from "@foundry/core/agents";

export type {
  Capability,
  CapabilityKind,
  CommandAuthorityDefinition,
  CommandEffect,
  CommandSignature,
  CommandTarget,
  DomainCommandCapability,
  ToolSource,
} from "@foundry/core/agents";

export function describeCapability(capability: Capability): string {
  switch (capability.kind) {
    case "web.fetch":
      return `web.fetch::${capability.domain}`;
    case "mcp.tool":
      return `mcp.tool::${capability.serverId}::${capability.tool}`;
    case "fs.read":
      return `fs.read::${capability.projectId}::${capability.root}`;
    case "domain.command":
      return `domain.command::${JSON.stringify([
        capability.domain,
        capability.command.id,
        capability.command.version,
        capability.effect,
        capability.target.projectId,
        capability.target.scope,
      ])}`;
    case "tool.call":
      return `tool.call::${capability.source}::${capability.tool}`;
    default:
      break;
  }
  return undefined as never;
}

export interface CapabilityExplanation {
  readonly action: string;
  readonly subject: string;
}

export function explainCapability(
  capability: Capability
): CapabilityExplanation {
  switch (capability.kind) {
    case "web.fetch":
      return { action: `fetch ${capability.domain}`, subject: "The agent" };
    case "mcp.tool":
      return {
        action: `run tool ${capability.tool}`,
        subject: capability.serverId,
      };
    case "fs.read":
      return {
        action: `read files in ${capability.projectId} (${capability.root})`,
        subject: "The agent",
      };
    case "domain.command":
      return {
        action: `run ${capability.command.id}@${String(capability.command.version)} (${capability.effect}) on ${capability.target.scope} for ${capability.target.projectId}`,
        subject: "The agent",
      };
    case "tool.call":
      return {
        action: `run tool ${capability.tool} (${capability.source})`,
        subject: "The agent",
      };
    default:
      break;
  }
  return undefined as never;
}

export function classifyCommandCapability(
  authority: unknown,
  known: readonly CommandAuthorityDefinition[],
  fallback: { readonly source: ToolSource; readonly tool: string }
): Capability {
  if (!isDomainCommandCapability(authority)) {
    return { kind: "tool.call", ...fallback };
  }
  const recognized = known.some(
    (definition) =>
      definition.domain === authority.domain &&
      definition.command.id === authority.command.id &&
      definition.command.version === authority.command.version &&
      definition.effects.includes(authority.effect)
  );
  return recognized ? authority : { kind: "tool.call", ...fallback };
}

function isDomainCommandCapability(
  value: unknown
): value is DomainCommandCapability {
  if (!isRecord(value) || value.kind !== "domain.command") {
    return false;
  }
  if (
    typeof value.domain !== "string" ||
    value.domain.length === 0 ||
    !isRecord(value.command) ||
    typeof value.command.id !== "string" ||
    value.command.id.length === 0 ||
    typeof value.command.version !== "number" ||
    !Number.isInteger(value.command.version) ||
    value.command.version < 1 ||
    !isRecord(value.target) ||
    typeof value.target.projectId !== "string" ||
    value.target.projectId.length === 0 ||
    typeof value.target.scope !== "string" ||
    value.target.scope.length === 0
  ) {
    return false;
  }
  return (
    value.effect === "read" ||
    value.effect === "compute" ||
    value.effect === "write"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
