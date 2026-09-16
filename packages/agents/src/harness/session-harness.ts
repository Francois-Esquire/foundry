import type {
  AgentCallParameters,
  AgentStreamParameters,
  GenerateTextResult,
  ModelMessage,
  ProviderMetadata,
  StreamTextResult,
  ToolSet,
} from "ai";

import { generateId } from "ai";

import type { TurnContext } from "../agents/loop-agent";
import type { Mesh } from "../agents/mesh";
import { createMesh } from "../agents/mesh";
import type { AgentCompatibilityRegistry } from "../agents/registry";
import { createAgentCompatibilityRegistry } from "../agents/registry";
import type { SessionWindowOptions, WindowModel } from "../contexts";
import {
  cacheDirectivesFor,
  effectiveLimit,
  estimatingCounter,
  mergeProviderOptions,
  resolveBudget,
} from "../contexts";
import type {
  SessionInput,
  SessionMessage,
  SessionPart,
  SessionRole,
  SessionStore,
  SessionStream,
  StreamHandlers,
  SummarizableStore,
  Summarizer,
} from "../session";
import { InMemorySessionStore, maybeCompact } from "../session";
import {
  toModelMessages,
  validateApprovalResponse,
} from "../session/converter";
import type { AgentHarnessSettings } from "./agent-harness";
import { AgentHarness } from "./agent-harness";
import type { StreamPart, StreamSource } from "./stream-transform";
import { transformStream } from "./stream-transform";

export type SessionHarnessSettings = AgentHarnessSettings & {
  /** Omit to run stateless — nothing is persisted. */
  store?: SessionStore;
  /** Adopt an existing session id, or generate one on first turn. */
  sessionId?: string;
  /** Agent registry for multi-agent routing. Auto-created when omitted. */
  registry?: AgentCompatibilityRegistry;
  /** Mesh for inter-agent communication. Auto-created when omitted. */
  mesh?: Mesh;
  /** Node id for this harness in the mesh (defaults to "primary"). */
  nodeId?: string;
  /**
   * Build the per-turn tool context, passed to tools as their `context`.
   * Receives the **resolved** session id, so tools see the real session even
   * when it's created lazily on the first turn. Omit to fall back to the
   * construction-time runtime context (if any).
   */
  toolContext?: (sessionId: string) => Record<string, unknown>;
  /**
   * Auto-compaction: before each turn, if the active context exceeds the turn
   * model's budget, fold older history into a summary. Requires a summarize-aware
   * store; silently skipped otherwise. Best-effort — a failure never breaks a turn.
   */
  compaction?: CompactionSettings;
};

export interface CompactionSettings {
  /** Tokens of recent history kept unfolded. Default: half the headroom. */
  keepTokens?: number;
  /** The window the active context is sized to fit. Defaults to the turn
   *  model's own `limits`. */
  model?: WindowModel;
  /** Produces the summary text — wrap a cheap model with `createModelSummarizer`. */
  summarizer: Summarizer;
  /** Sizing knobs (reservedOutput, safetyMarginRatio, highWaterRatio, counter). */
  window?: SessionWindowOptions;
}

/** High-water fraction of headroom that triggers a compaction. */
const DEFAULT_COMPACTION_HIGH_WATER = 0.8;

export type SessionStreamOptions = {
  signal?: AbortSignal;
} & StreamHandlers;

/**
 * {@link AgentHarness} extended with session persistence. Decorates
 * {@link stream} and {@link generate} with identity resolution, input append,
 * history replay, and assistant commit — all on top of {@link transformStream}.
 */
export class SessionHarness extends AgentHarness {
  readonly #store: SessionStore | undefined;
  readonly #registry: AgentCompatibilityRegistry;
  readonly #mesh: Mesh;
  readonly #nodeId: string;
  readonly #toolContext:
    | ((sessionId: string) => Record<string, unknown>)
    | undefined;
  readonly #compaction: CompactionSettings | undefined;
  /** Construction-time providerOptions, merged under per-turn cache directives. */
  readonly #baseProviderOptions:
    | Record<string, Record<string, unknown>>
    | undefined;
  #sessionId: string | undefined;

  constructor(settings: SessionHarnessSettings, context: TurnContext) {
    const {
      store = new InMemorySessionStore(),
      sessionId,
      registry,
      mesh,
      nodeId,
      toolContext,
      compaction,
      tools,
      ...harnessSettings
    } = settings;
    const agentRegistry = registry ?? createAgentCompatibilityRegistry();
    const agentMesh = mesh ?? createMesh({ registry: agentRegistry, store });
    const resolvedNodeId = nodeId ?? "primary";

    // Mesh tools carry `source: "mesh"` on themselves, so the compiler keeps
    // that attribution for policy and audit even though they share one map.
    super(
      {
        ...harnessSettings,
        tools: { ...tools, ...agentMesh.tools(resolvedNodeId) },
      },
      context
    );
    this.#store = store;
    this.#sessionId = sessionId;
    this.#registry = agentRegistry;
    this.#mesh = agentMesh;
    this.#nodeId = resolvedNodeId;
    this.#toolContext = toolContext;
    this.#compaction = compaction;
    this.#baseProviderOptions = settings.providerOptions;
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  get store(): SessionStore | undefined {
    return this.#store;
  }

  get registry(): AgentCompatibilityRegistry {
    return this.#registry;
  }

  get mesh(): Mesh {
    return this.#mesh;
  }

  get nodeId(): string {
    return this.#nodeId;
  }

  override stream(
    input: SessionInput,
    opts?: SessionStreamOptions
  ): SessionStream;
  override stream(
    opts: AgentStreamParameters<never, ToolSet>
  ): Promise<StreamTextResult<ToolSet, Record<string, unknown>, never>>;
  override stream(
    inputOrOpts: SessionInput | AgentStreamParameters<never, ToolSet>,
    opts?: SessionStreamOptions
  ):
    | SessionStream
    | Promise<StreamTextResult<ToolSet, Record<string, unknown>, never>> {
    if (typeof inputOrOpts !== "string" && !("parts" in inputOrOpts)) {
      return super.stream(inputOrOpts);
    }
    return this.#sessionStream(inputOrOpts, opts ?? {});
  }

  override generate(
    input: SessionInput,
    opts?: SessionStreamOptions
  ): Promise<SessionMessage>;
  override generate(
    opts: AgentCallParameters<never, ToolSet>
  ): Promise<GenerateTextResult<ToolSet, Record<string, unknown>, never>>;
  override generate(
    inputOrOpts: SessionInput | AgentCallParameters<never, ToolSet>,
    opts?: SessionStreamOptions
  ):
    | Promise<SessionMessage>
    | Promise<GenerateTextResult<ToolSet, Record<string, unknown>, never>> {
    if (typeof inputOrOpts !== "string" && !("parts" in inputOrOpts)) {
      return super.generate(inputOrOpts);
    }
    return this.#sessionGenerate(inputOrOpts, opts ?? {});
  }

  #sessionStream(
    input: SessionInput,
    runOptions: SessionStreamOptions
  ): SessionStream {
    let resolvedSessionId: string | undefined;

    const source: StreamSource = (async () => {
      const inputParts = normalizeInput(input);
      await this.#validateApprovalResponses(inputParts);

      let messages: ModelMessage[];
      let experimentalContext: Record<string, unknown> | undefined;
      if (this.#store) {
        resolvedSessionId = await this.#ensureSession();
        await this.#store.appendMessage({
          parts: inputParts,
          role: inputRole(inputParts),
          sessionId: resolvedSessionId,
        });
        await this.#maybeCompact(resolvedSessionId);
        const history = await readContext(this.#store, resolvedSessionId);
        messages = await toModelMessages(history, this.agent.tools);
        experimentalContext = this.#toolContext?.(resolvedSessionId);
      } else {
        messages = await toModelMessages(
          [transientMessage(inputParts)],
          this.agent.tools
        );
        experimentalContext = this.#toolContext?.("");
      }

      const providerOptions = this.#applyCacheDirectives(
        messages,
        resolvedSessionId
      );

      // The session id is only known once the first turn ensures it, so the
      // turn's context is built here and handed to the already-built agent.
      this.setToolsContext(experimentalContext);

      const result = await super.stream({
        messages,
        ...(runOptions.signal ? { abortSignal: runOptions.signal } : {}),
        ...(providerOptions ? { providerOptions } : {}),
      });
      return result.stream as AsyncIterable<StreamPart>;
    })();

    const store = this.#store;
    const commit = store
      ? (message: SessionMessage): Promise<SessionMessage> => {
          const sid = resolvedSessionId;
          if (!sid) {
            return Promise.resolve({ ...message, sessionId: "" });
          }
          return store
            .appendMessage({
              metadata: message.metadata,
              parts: message.parts,
              role: "assistant",
              sessionId: sid,
              status: message.status,
            })
            .catch(() => ({ ...message, sessionId: sid }));
        }
      : undefined;

    return transformStream(source, {
      handlers: runOptions,
      model: this.route,
      ...(commit ? { commit } : {}),
    });
  }

  async #sessionGenerate(
    input: SessionInput,
    runOptions: SessionStreamOptions
  ): Promise<SessionMessage> {
    const stream = this.#sessionStream(input, runOptions);
    return stream.message;
  }

  /**
   * Apply this turn's provider cache directives (contexts/cache). Mutates
   * `messages` to mark the Anthropic `cacheControl` breakpoint on the last
   * (appended-only, therefore now-stable) message, and returns the request-level
   * options (OpenAI `promptCacheKey` / Google `cachedContent`) merged over the
   * agent's construction-time `providerOptions`. No-ops when the provider/model
   * is unknown; OpenAI/Google otherwise ride the stable prefix for free.
   *
   * Drives both turn entry points — `stream` directly and `generate` via
   * {@link SessionHarness.#sessionGenerate}.
   */
  #applyCacheDirectives(
    messages: ModelMessage[],
    sessionId: string | undefined
  ): ProviderMetadata | undefined {
    const directives = cacheDirectivesFor({
      modelId: this.route.id,
      ...(this.route.provider ? { provider: this.route.provider } : {}),
      ...(sessionId ? { sessionId } : {}),
    });

    if (directives.breakpoint) {
      const last = messages.at(-1);
      if (last) {
        last.providerOptions = mergeProviderOptions(
          last.providerOptions,
          directives.breakpoint
        ) as ProviderMetadata | undefined;
      }
    }

    if (!directives.request) {
      return undefined;
    }
    return mergeProviderOptions(
      this.#baseProviderOptions,
      directives.request
    ) as ProviderMetadata | undefined;
  }

  /**
   * Best-effort pre-turn compaction. Computes the budget from the turn model (the
   * contexts math lives here so the session layer stays free of it), then folds
   * older history when over the high-water mark. Never throws into the turn.
   */
  async #maybeCompact(sessionId: string): Promise<void> {
    const c = this.#compaction;
    const store = this.#store ? asSummarizable(this.#store) : undefined;
    if (!(c && store)) {
      return;
    }
    try {
      const counter = c.window?.counter ?? estimatingCounter;
      const budget = resolveBudget(
        c.model ?? { id: this.route.id, ...this.model.limits },
        c.window
      );
      const limit = effectiveLimit(
        budget,
        c.window?.highWaterRatio ?? DEFAULT_COMPACTION_HIGH_WATER
      );
      const keepTokens = c.keepTokens ?? Math.floor(budget.headroom * 0.5);
      await maybeCompact(store, c.summarizer, sessionId, {
        counter,
        keepTokens,
        limit,
      });
    } catch {
      // Compaction is best-effort: a summarizer failure must not break the turn.
    }
  }

  /**
   * Reject a malformed, duplicate, or mismatched approval response before
   * it's appended to history — and therefore before any tool can execute
   * from it. Uses whatever history already exists for this session (or none,
   * pre-first-turn/stateless), never the input being validated.
   */
  async #validateApprovalResponses(parts: SessionPart[]): Promise<void> {
    const responses = parts.filter(
      (p): p is Extract<SessionPart, { type: "tool_approval_response" }> =>
        p.type === "tool_approval_response"
    );
    if (responses.length === 0) {
      return;
    }
    const history =
      this.#store && this.#sessionId
        ? await this.#store.listMessages(this.#sessionId)
        : [];
    for (const response of responses) {
      validateApprovalResponse(history, response);
    }
  }

  async #ensureSession(): Promise<string> {
    if (!this.#store) {
      throw new Error("ensureSession called without a store");
    }
    if (this.#sessionId) {
      const existing = await this.#store.getSession(this.#sessionId);
      if (existing) {
        return existing.id;
      }
    }
    const created = await this.#store.createSession({ id: this.#sessionId });
    this.#sessionId = created.id;
    return created.id;
  }
}

/** Thin alias for the inherited {@link AgentHarness.create}, kept for existing
 *  callers. Build-time MCP resolution is the base class's; this subclass adds
 *  only Session continuity and the session-scoped mesh. */

/**
 * The messages a turn sends: the active view (summary prepended) when the store
 * supports it, else raw history. Keeps stores that aren't summarize-aware working.
 */
function readContext(
  store: SessionStore,
  sessionId: string
): Promise<SessionMessage[]> {
  const summarizable = asSummarizable(store);
  return summarizable
    ? summarizable.activeMessages(sessionId)
    : store.listMessages(sessionId);
}

/** Narrow a store to {@link SummarizableStore} when it exposes the active view. */
function asSummarizable(store: SessionStore): SummarizableStore | undefined {
  return "activeMessages" in store ? (store as SummarizableStore) : undefined;
}

function normalizeInput(input: SessionInput): SessionPart[] {
  return typeof input === "string"
    ? [{ text: input, type: "text" }]
    : input.parts;
}

function inputRole(parts: SessionPart[]): SessionRole {
  return parts.length > 0 &&
    parts.every(
      (p) => p.type === "tool_result" || p.type === "tool_approval_response"
    )
    ? "tool"
    : "user";
}

function transientMessage(parts: SessionPart[]): SessionMessage {
  const now = Date.now();
  return {
    createdAt: now,
    id: generateId(),
    parts,
    role: inputRole(parts),
    sessionId: "",
    status: "complete",
    updatedAt: now,
  };
}
