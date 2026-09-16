import type {
  AgentCallParameters,
  AgentStreamParameters,
  GenerateTextResult,
  ModelMessage,
  StreamTextResult,
  ToolSet,
} from "ai";

import type { LoopAgentSettings, TurnContext } from "../agents/loop-agent";
import { LoopAgent } from "../agents/loop-agent";
import type { AgentModel, ModelRoute } from "../agents/model";
import { routeOf } from "../agents/model";
import type { AgentAuthorizer } from "../authorization";
import { createInMemoryAgentAuthorizer } from "../authorization";
import { createToolContext } from "../tools/context";
import { directToolEffectPort } from "./effect-port";
import type { StreamPart } from "./stream-transform";
import { compileTools, withToolCallRegistration } from "./tool-compiler";
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
};

/**
 * Read a property off `target`, always invoking a function-typed value with
 * `this = target`. Backs the `stream`-augmenting proxy in {@link
 * AgentHarness.#withToolCallRegistration}: the AI SDK's `StreamTextResult`
 * methods close over private class fields, so calling one with the proxy
 * itself as `this` (the default when a method is looked up then invoked
 * through a Proxy) would fail that class's private-field brand check.
 */
function delegateProperty(target: object, prop: string | symbol): unknown {
  const value: unknown = Reflect.get(target, prop, target);
  if (typeof value !== "function") {
    return value;
  }
  const fn = value as (...args: unknown[]) => unknown;
  return fn.bind(target);
}

export class AgentHarness {
  readonly agent: LoopAgent;
  /** The model this harness runs, as the host handed it in. */
  readonly model: AgentModel;
  /** The route recorded on every message this harness produces. */
  readonly route: ModelRoute;
  /**
   * The authority this harness runs under — the one every compiled tool call
   * is checked against, and the one attached to each call's tool context (see
   * {@link AgentHarness.#toolContext}). Resolved once at construction
   * from `settings.policy`, or the permissive default when a caller
   * configures none. `SessionHarness` inherits it unchanged: it forwards its
   * settings straight through `super(...)`, so a session and the agent it
   * runs are never under two different policies.
   */
  readonly policy: AgentAuthorizer;
  /** The agent preset this harness runs as — the Subject of its authorization. */
  readonly agentId: string;
  /** The preset generation, when the host tracks generations. */
  readonly agentGeneration?: number;
  readonly #registrationFor: ReturnType<typeof compileTools>["registrationFor"];
  /** The object every tool of the current call receives as its `context`. */
  #currentToolContext: Record<string, unknown>;

  constructor(settings: AgentHarnessSettings, context: TurnContext) {
    const {
      tools,
      policy,
      effectPort,
      agentId,
      agentGeneration,
      toolsContext,
      ...rest
    } = settings;

    this.model = settings.model;
    this.route = routeOf(settings.model);
    this.policy = policy ?? defaultPermissiveAuthorizer();
    this.agentId = agentId ?? DEFAULT_AGENT_ID;
    if (agentGeneration !== undefined) {
      this.agentGeneration = agentGeneration;
    }
    // Every tool is compiled through the same policy/effect seam; a later
    // entry in the caller's map wins on a duplicate name, as in any spread.
    const compiled = compileTools(tools ?? {}, {
      agentId: this.agentId,
      ...(agentGeneration === undefined ? {} : { agentGeneration }),
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      effectPort: effectPort ?? directToolEffectPort,
      policy: this.policy,
    });
    this.#registrationFor = compiled.registrationFor;

    const agentSettings: LoopAgentSettings = { ...rest, tools: compiled.tools };
    // AI SDK v7 takes tool context on the agent rather than per call, and keys
    // it by tool name. Every tool gets the *same* object, which is what the v6
    // single `experimental_context` did — identity is the contract, since hosts
    // freeze and brand what they pass (`@foundry/analyze` puts its live
    // dispatch behind a `WeakSet`). Copying a context would strip that brand,
    // so each entry is a getter onto the current one: the agent is built once,
    // and a subclass can still swap in a later-resolved context (a session's id
    // is only known on its first turn) without any copy. The SDK reads
    // `toolsContext[toolName]` per call and never clones the map.
    //
    // Assigned rather than inlined because the SDK types this off each tool's
    // `contextSchema`, which a broadly-typed `ToolSet` cannot express.
    this.#currentToolContext = this.#toolContext(toolsContext);
    const toolsContextMap: Record<string, unknown> = {};
    for (const name of Object.keys(compiled.tools)) {
      Object.defineProperty(toolsContextMap, name, {
        configurable: true,
        enumerable: true,
        get: () => this.#currentToolContext,
      });
    }
    (agentSettings as { toolsContext?: Record<string, unknown> }).toolsContext =
      toolsContextMap;

    this.agent = new LoopAgent(agentSettings, context);
  }
  async stream(
    opts: AgentStreamParameters<never, ToolSet>
  ): Promise<StreamTextResult<ToolSet, Record<string, unknown>, never>> {
    const result = await this.agent.stream(opts);
    return this.#withToolCallRegistration(result, opts);
  }

  /**
   * One call's tool context: whatever the caller passed, carrying this
   * harness's {@link AgentHarness.policy}, so a tool can reach the authority
   * it runs under without the host threading one through its own context
   * shape.
   *
   * The caller's object comes back unchanged and identical — the host owns
   * that shape, and `createToolContext` attaches the policy beside it rather
   * than rewriting it. A non-object context (the SDK types it `unknown`) can
   * carry nothing and passes straight through; losing the caller's value
   * would be the worse failure, and `getPolicy` already reports absence.
   */
  // AI SDK v7 constrains runtime context to a record, so a primitive context is
  // no longer representable — every caller context flows through createToolContext.
  #toolContext(
    context: Record<string, unknown> | undefined
  ): Record<string, unknown> {
    // The SDK constrains tool context to `Record<string, unknown>`; our own
    // context types stay interfaces, so the widening happens once, here.
    return (
      context === undefined
        ? createToolContext({ policy: this.policy })
        : createToolContext({ policy: this.policy }, context)
    ) as Record<string, unknown>;
  }

  /**
   * Point the agent's tool context at `context` for the calls that follow.
   * The caller's object is carried through unchanged and identical — a host
   * that branded it keeps that brand — so a subclass whose context only
   * resolves per turn never has to rebuild the agent.
   */
  protected setToolsContext(
    context: Record<string, unknown> | undefined
  ): void {
    this.#currentToolContext = this.#toolContext(context);
  }

  /**
   * Attach registration provenance to tool calls and the derived `capability`
   * to approval requests on `stream`. Delegates
   * every other property/method to the real result unchanged: the AI SDK's
   * `StreamTextResult` implementation backs its getters/methods with
   * private class fields, so the proxy always resolves and binds against
   * the real `target`, never the proxy itself, to avoid failing that
   * private-field brand check.
   */
  #withToolCallRegistration(
    result: StreamTextResult<ToolSet, Record<string, unknown>, never>,
    opts: { messages?: ModelMessage[] }
  ): StreamTextResult<ToolSet, Record<string, unknown>, never> {
    const registrationFor = this.#registrationFor;
    const call = {
      agentId: this.agentId,
      // The context the tools of this call actually receive. v7 binds it to the
      // agent, so it is read here rather than off the call's parameters —
      // capability derivation needs the host's branded object, not `undefined`.
      experimentalContext: this.#currentToolContext,
      messages: opts.messages ?? [],
      ...(this.agentGeneration === undefined
        ? {}
        : { agentGeneration: this.agentGeneration }),
    };
    const handler: ProxyHandler<
      StreamTextResult<ToolSet, Record<string, unknown>, never>
    > = {
      get(target, prop) {
        if (prop === "stream") {
          return withToolCallRegistration(
            target.stream as unknown as AsyncIterable<StreamPart>,
            registrationFor,
            call
          );
        }
        return delegateProperty(target, prop);
      },
    };
    return new Proxy(result, handler);
  }

  generate(
    opts: AgentCallParameters<never, ToolSet>
  ): Promise<GenerateTextResult<ToolSet, Record<string, unknown>, never>> {
    return this.agent.generate(opts);
  }
}
