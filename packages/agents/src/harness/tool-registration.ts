import type { ModelMessage, Tool, ToolSet } from "ai";

import type { Capability, ToolSource } from "../authorization/capability";
import type { ToolEffectLocation } from "../schema";

export type { ToolEffectLocation } from "../schema";

export interface AgentIdentity {
  agentGeneration?: number;
  agentId: string;
  sessionId: string;
}

export interface AgentInvocationContext extends AgentIdentity {
  experimentalContext?: unknown;
  messages: ModelMessage[];
  toolCallId: string;
}

export interface HarnessToolRegistration {
  capability: (input: unknown, context: AgentInvocationContext) => Capability;
  effectLocation?: ToolEffectLocation;
  name: string;
  source: ToolSource;
  tool: Tool;
}

export interface ToolMeta {
  capability?: (input: unknown, context: AgentInvocationContext) => Capability;
  effectLocation?: ToolEffectLocation;
  source?: ToolSource;
}

export const TOOL_META: unique symbol = Symbol.for("foundry.tool-meta");

type TaggedTool = Tool & { [TOOL_META]?: ToolMeta };

export function tagTool(tool: Tool, meta: ToolMeta): Tool {
  const tagged: TaggedTool = {
    ...tool,
    [TOOL_META]: { ...metaOf(tool), ...meta },
  };
  return tagged;
}

export function tagTools(tools: ToolSet, source: ToolSource): ToolSet {
  const out: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    out[name] = metaOf(tool).source ? tool : tagTool(tool, { source });
  }
  return out;
}

export function metaOf(tool: Tool): ToolMeta {
  return (tool as TaggedTool)[TOOL_META] ?? {};
}

export function registrationsOf(
  tools: ToolSet | undefined,
  fallbackSource: ToolSource
): HarnessToolRegistration[] {
  if (!tools) {
    return [];
  }
  return Object.entries(tools).map(([name, tool]): HarnessToolRegistration => {
    const meta = metaOf(tool);
    const source = meta.source ?? fallbackSource;
    return {
      capability:
        meta.capability ??
        ((): Capability => ({ kind: "tool.call", source, tool: name })),
      effectLocation: meta.effectLocation,
      name,
      source,
      tool,
    };
  });
}

export interface RegisteredToolCall<TInput = unknown> extends AgentIdentity {
  capability: Capability;
  effectLocation: ToolEffectLocation;
  input: TInput;
  invocationId: string;
  source: ToolSource;
  toolCallId: string;
  toolName: string;
}
