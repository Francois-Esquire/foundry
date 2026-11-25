export type ToolSource =
  | "declared"
  | "builtin"
  | "skill"
  | "mcp"
  | "mesh"
  | "module"
  | "harness";

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

export type Capability =
  | { kind: "web.fetch"; domain: string }
  | { kind: "mcp.tool"; serverId: string; tool: string }
  | { kind: "fs.read"; projectId: string; root: string }
  | DomainCommandCapability
  | { kind: "tool.call"; source: ToolSource; tool: string };

export type CapabilityKind = Capability["kind"];
