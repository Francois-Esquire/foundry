import { randomUUID } from "node:crypto";
import type { GenerateTextResult, StreamTextResult, ToolSet } from "ai";

import type {
  LoopAgentCallParameters,
  LoopAgentSettings,
  LoopAgentStreamParameters,
  TurnContext,
} from "../agents/loop-agent";
import { LoopAgent } from "../agents/loop-agent";
import type { AgentModel, ModelRoute } from "../agents/model";
import { routeOf } from "../agents/model";
import type { AgentAuthorizer } from "../authorization/authorization";
import { createInMemoryAgentAuthorizer } from "../authorization/authorization";
import { createToolContext } from "../tools/context";
import { directToolEffectPort } from "./effect-port";
import type { StreamPart } from "./stream-transform";
import { compileTools, withToolCallRegistration } from "./tool-compiler";
import type { HarnessPermissionCallback } from "./turn-driver";
import type { ToolEffectPort } from "./types";

/** Stable placeholder identity for the agent Subject when a caller configures
 *  no `agentId`. */
const DEFAULT_AGENT_ID = "agent";

/**
 * The harness's own default when a caller configures no {@link AgentAuthorizer}
 * — fully permissive, including an explicit `tool.call` kind mode (the one
 * capability that can never fall through to a blanket global mode; see
 * `authorization/authorization.ts`). Keeps lightweight direct/CLI use of {@link
 * AgentHarness} working unchanged. A caller that wants real gating passes its
 * own `policy`.
 *
 * Its Grant repository is empty and stays that way: every decision comes from
 * the Policy tiers, so there is nothing to persist or read back.
 */
function defaultPermissiveAuthorizer(): AgentAuthorizer {
  return createInMemoryAgentAuthorizer({
    policy: { byKind: { "tool.call": "allow" }, global: "allow" },
  }).authorizer;
}

/**
 * `ToolLoopAgent` settings plus the harness's own seams. `tools` is the whole
 * tool surface, in AI SDK shape: compose it yourself from whatever sources
 * apply (`createSkillRegistry(...).tools`, `createTodos().tools`,
 * `mcp.tools()`, a sandbox toolkit's `.tools`) and join their `instructions`
 * the same way. A tool carrying its own `ToolMeta` (see `tagTool`) keeps that
 * source and capability through compilation; the rest are `declared` with
 * the generic `tool.call` capability.
 */
export type AgentHarnessSettings = Omit<LoopAgentSettings, "toolsContext"> & {
  /**
   * Tool context handed to every tool call as its `context`, carrying this
   * harness's {@link AgentHarness.policy}. AI SDK v7 takes this on the agent
   * rather than per call, and types it off each tool's `contextSchema`, which
   * a broadly-typed `ToolSet` cannot express — so it is declared here.
   */
  toolsContext?: Record<string, unknown>;
  /** Stable identity of the agent preset — the Subject every authorization
   *  request for this agent is made under. Defaults to a generic placeholder. */
  agentId?: string;
  /** Authorizer every compiled tool call is checked against. Defaults to a
   *  fully permissive one so lightweight/direct use without a host-configured
   *  authorizer keeps working unchanged. */
  policy?: AgentAuthorizer;
  /** The preset generation this harness was built from, carried into the agent
   *  Subject so a new generation does not inherit the previous one's Grants. */
  agentGeneration?: number;
  /** Effect boundary every allowed tool call executes through. Defaults to
   *  a direct in-process executor; Studio injects a Run-aware adapter. */
  effectPort?: ToolEffectPort;
  /** Optional live authorization. The callback owns one claim before execution;
   * policy asks do not become SDK suspension/replay checkpoints. */
  permission?: HarnessPermissionCallback;
  /** The session this harness acts for. A fresh id when omitted or empty. */
  sessionId?: string;
};

/** One streamed turn: the SDK result, and its parts with every tool call
 *  stamped with the registration the compiler gave it. */
export interface AgentHarnessStream {
  readonly parts: AsyncIterable<StreamPart>;
  readonly result: StreamTextResult<ToolSet, Record<string, unknown>, never>;
}

export class AgentHarness {
  readonly agent: LoopAgent;
  /** The model this harness runs, as the host handed it in. */
  readonly model: AgentModel;
  /** The route recorded on every message this harness produces. */
  readonly route: ModelRoute;
  /**
   * The authority this harness runs under — the one every compiled tool call
   * is checked against, and the one attached to its tool context. Resolved
   * once at construction from `settings.policy`, or the permissive default
   * when a caller configures none.
   */
  readonly policy: AgentAuthorizer;
  /** The agent preset this harness runs as — the Subject of its authorization. */
  readonly agentId: string;
  /** The preset generation, when the host tracks generations. */
  readonly agentGeneration?: number;
  /** The session this harness acts for: the `scopeId` of every authorization
   *  request its tools make, and the session its turns are observed under. */
  readonly sessionId: string;
  readonly #registrationFor: ReturnType<typeof compileTools>["registrationFor"];
  /** The object every tool receives as its `context`. */
  readonly #toolsContext: Record<string, unknown>;

  constructor(settings: AgentHarnessSettings, context?: TurnContext) {
    const {
      tools,
      policy,
      effectPort,
      agentId,
      agentGeneration,
      sessionId,
      toolsContext,
      permission,
      ...rest
    } = settings;

    this.model = settings.model;
    this.route = routeOf(settings.model);
    this.policy = policy ?? defaultPermissiveAuthorizer();
    this.agentId = agentId ?? DEFAULT_AGENT_ID;
    this.agentGeneration = agentGeneration;
    // Fixed before any tool is compiled: every call's authorization request is
    // scoped by it, and a session-lifetime Grant cannot be issued without one.
    this.sessionId = sessionId || context?.sessionId || randomUUID();
    // Every tool is compiled through the same policy/effect seam; a later
    // entry in the caller's map wins on a duplicate name, as in any spread.
    const compiled = compileTools(tools ?? {}, {
      agentGeneration,
      agentId: this.agentId,
      effectPort: effectPort ?? directToolEffectPort,
      permission,
      policy: this.policy,
      sessionId: this.sessionId,
    });
    this.#registrationFor = compiled.registrationFor;

    // The caller's object comes back unchanged and identical — the host owns
    // that shape, and `createToolContext` attaches the policy beside it rather
    // than rewriting it. The SDK constrains tool context to
    // `Record<string, unknown>`; our own context types stay interfaces, so the
    // widening happens once, here.
    this.#toolsContext = (
      toolsContext === undefined
        ? createToolContext({ policy: this.policy })
        : createToolContext({ policy: this.policy }, toolsContext)
    ) as Record<string, unknown>;

    const agentSettings: LoopAgentSettings = { ...rest, tools: compiled.tools };
    // AI SDK v7 takes tool context on the agent rather than per call, and keys
    // it by tool name. Every tool gets the *same* object, which is what the v6
    // single `experimental_context` did — identity is the contract, since hosts
    // freeze and brand what they pass (`@foundry/analyze` puts its live
    // dispatch behind a `WeakSet`), and copying would strip that brand.
    //
    // Assigned rather than inlined because the SDK types this off each tool's
    // `contextSchema`, which a broadly-typed `ToolSet` cannot express.
    (agentSettings as { toolsContext?: Record<string, unknown> }).toolsContext =
      Object.fromEntries(
        Object.keys(compiled.tools).map((name) => [name, this.#toolsContext])
      );

    this.agent = new LoopAgent(agentSettings, { sessionId: this.sessionId });
  }

  /**
   * Stream one turn. `parts` carries registration provenance on each tool call
   * and the derived `capability` on each approval request — the facts the
   * session layer persists, which only the live compiler still knows.
   */
  async stream(opts: LoopAgentStreamParameters): Promise<AgentHarnessStream> {
    const result = await this.agent.stream(opts);
    return {
      parts: withToolCallRegistration(result.stream, this.#registrationFor, {
        experimentalContext: this.#toolsContext,
        messages: opts.messages ?? [],
      }),
      result,
    };
  }

  /**
   * Run one turn to completion. There are no parts to stamp: the compiled
   * tools authorize every call just as they do when streaming, and the
   * provenance stamping only serves the session layer, which always streams.
   */
  generate(
    opts: LoopAgentCallParameters
  ): Promise<GenerateTextResult<ToolSet, Record<string, unknown>, never>> {
    return this.agent.generate(opts);
  }
}
