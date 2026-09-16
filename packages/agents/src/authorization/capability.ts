/**
 * Where a tool registered from — the harness's tool-source vocabulary. Carried
 * on the generic {@link Capability} so a policy or audit trail can tell a
 * hand-declared tool from an MCP server's without a second lookup.
 */
export type ToolSource =
  | "declared"
  | "builtin"
  | "skill"
  | "mcp"
  | "mesh"
  | "module";

export type CommandEffect = "read" | "compute" | "write";

export type CommandSignature = Readonly<{
  id: string;
  version: number;
}>;

export type CommandTarget = Readonly<{
  projectId: string;
  scope: string;
}>;

export type DomainCommandCapability = Readonly<{
  kind: "domain.command";
  domain: string;
  command: CommandSignature;
  target: CommandTarget;
  effect: CommandEffect;
}>;

export interface CommandAuthorityDefinition {
  readonly command: CommandSignature;
  readonly domain: string;
  readonly effects: readonly CommandEffect[];
}

/**
 * The capabilities an agent-driven action can ask consent for. Structural — a
 * capability is data, so policies, stores, and transports can be keyed on it
 * without knowing who is asking.
 */
export type Capability =
  | { kind: "web.fetch"; domain: string }
  | { kind: "mcp.tool"; serverId: string; tool: string }
  /** Read-only host-FS access to one project root. `root` is the canonical
   * realpath — baked into the key so re-pointing the project root kills the
   * grant and re-prompts. */
  | { kind: "fs.read"; projectId: string; root: string }
  /** Versioned command authority over one exact canonical target. The command
   * catalog validates and constructs this shape; model input never supplies
   * the authority object itself. */
  | DomainCommandCapability
  /** The generic fallback for a tool without a more specific authority
   * vocabulary. This is the one capability the policy treats as
   * unclassified: it fails closed rather than riding a blanket global
   * "allow", because no shape here tells the policy what the tool actually
   * does. */
  | { kind: "tool.call"; source: ToolSource; tool: string };

export type CapabilityKind = Capability["kind"];

/**
 * A readable one-line description of a capability, for audit trails, logs, and
 * consent surfaces. Never use it as an identity — two descriptions can match
 * while the capabilities differ in a field this omits.
 */
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
  }
}

/**
 * How a capability reads to a human being asked to approve it.
 *
 * Distinct from {@link describeCapability}, which produces one flat line for an
 * audit trail. This is the framing an approval surface needs — who is asking,
 * and for what — and it lives here rather than in a renderer so every surface
 * that prompts says the same thing about the same capability.
 */
export interface CapabilityExplanation {
  /** What they want to do, in plain words. */
  readonly action: string;
  /** Who is asking: the agent, or the named module/server acting for it. */
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
  }
}

/**
 * Classify a code-derived command authority against published definitions.
 * Malformed or unknown authorities become generic `tool.call`, preserving the
 * policy's fail-closed behavior instead of manufacturing a classified grant.
 */
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
