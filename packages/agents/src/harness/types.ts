import type { ModelMessage, Tool, ToolSet } from "ai";

import type { Capability, ToolSource } from "../authorization";

/**
 * Everything a registration's {@link HarnessToolRegistration.capability}
 * function can use to derive a {@link Capability} from raw tool input — the
 * same identity and call history a compiled tool's own `execute`/
 * `needsApproval` receive from the AI SDK. Deliberately just "what a tool
 * call already knows," not preset-specific, so a later reusable-preset
 * contract (design: "Reusable agent preset") can reuse this shape unchanged.
 */
export interface AgentInvocationContext {
  agentId: string;
  experimentalContext?: unknown;
  messages: ModelMessage[];
  sessionId?: string;
  toolCallId: string;
}

/**
 * The compiler's own record for one tool: its name, its {@link ToolMeta}
 * resolved to concrete values, and the tool itself. Built by
 * {@link registrationsOf} from a plain tool map; not part of the harness's
 * public surface.
 */
export interface HarnessToolRegistration {
  /** Derive this call's capability from its input and invocation context.
   *  Pure — no side effects, no I/O; policy consultation and the effect
   *  boundary are the compiler's job, not the registration's. */
  capability: (input: unknown, context: AgentInvocationContext) => Capability;
  /** Where the registered call's effect is performed. When omitted, the
   *  compiler infers `runtime` for a tool with `execute` and `host` for a
   *  schema-only tool. `executor` is for a connected execution service that
   *  owns the effect outside both the runtime and its embedding host. */
  effectLocation?: ToolEffectLocation;
  name: string;
  source: ToolSource;
  tool: Tool;
}

/**
 * What the harness needs to know about a tool beyond its AI SDK shape: who
 * contributed it, what capability a call asks for, and where its effect runs.
 * Rides on the tool object itself under {@link TOOL_META}, so a tool map stays
 * a plain {@link ToolSet} the caller spreads and composes like any other.
 * Every field is optional; the compiler defaults `source` to `"declared"`,
 * `capability` to the generic `tool.call`, and infers `effectLocation`.
 */
export interface ToolMeta {
  capability?: (input: unknown, context: AgentInvocationContext) => Capability;
  effectLocation?: ToolEffectLocation;
  source?: ToolSource;
}

/** Symbol key, not a plain field: it cannot collide with a future AI SDK
 *  `Tool` field and never serializes. Object spread carries it through. */
export const TOOL_META: unique symbol = Symbol.for("foundry.tool-meta");

type TaggedTool = Tool & { [TOOL_META]?: ToolMeta };

/** Attach {@link ToolMeta} to one tool. Returns a new object; the input is untouched. */
export function tagTool(tool: Tool, meta: ToolMeta): Tool {
  const tagged: TaggedTool = {
    ...tool,
    [TOOL_META]: { ...metaOf(tool), ...meta },
  };
  return tagged;
}

/** Tag every tool in a map with a source (and, optionally, the same capability
 *  derivation). Tools that already carry a source keep it. */
export function tagTools(tools: ToolSet, source: ToolSource): ToolSet {
  const out: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    out[name] = metaOf(tool).source ? tool : tagTool(tool, { source });
  }
  return out;
}

/** Read a tool's {@link ToolMeta}; empty when it was never tagged. */
export function metaOf(tool: Tool): ToolMeta {
  return (tool as TaggedTool)[TOOL_META] ?? {};
}

/**
 * The compiler's view of a tool map: one registration per tool, with the
 * tool's own {@link ToolMeta} filled in by `fallbackSource` and the generic
 * `tool.call` capability where absent.
 */
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
      name,
      source,
      tool,
      ...(meta.effectLocation ? { effectLocation: meta.effectLocation } : {}),
      capability:
        meta.capability ??
        ((): Capability => ({ kind: "tool.call", source, tool: name })),
    };
  });
}

/**
 * Stable identity for one compiled tool call, handed to {@link
 * ToolEffectPort.execute} (design: "Effect boundary"). `invocationId` is the
 * idempotency/reconciliation key an externally-visible effect can key on
 * across a crash/replay boundary — derived stably per call by the compiler
 * (namespaced by agent, and session when present, over the AI SDK's own
 * `toolCallId`), so a replayed continuation reproduces the same id rather
 * than minting a new one and risking a double commit.
 */
export type ToolEffectLocation = "runtime" | "host" | "executor";

export interface RegisteredToolCall<TInput = unknown> {
  agentGeneration?: number;
  agentId: string;
  capability: Capability;
  effectLocation: ToolEffectLocation;
  input: TInput;
  invocationId: string;
  sessionId?: string;
  source: ToolSource;
  toolCallId: string;
  toolName: string;
}

/**
 * The boundary an approved runtime-owned tool effect runs through (design:
 * "Effect boundary"). {@link AgentHarness} supplies a direct in-process
 * default (see `effect-port.ts`); Studio injects a Run-aware adapter with a
 * recoverable child effect/Step. Contains no workflow type.
 */
export interface ToolEffectPort {
  execute<T>(call: RegisteredToolCall, effect: () => Promise<T>): Promise<T>;
}
