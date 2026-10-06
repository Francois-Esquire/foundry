import type { ModelMessage, ProviderMetadata } from "ai";

import type { LoopAgent, TurnContext } from "../agents/loop-agent";
import type { Mesh } from "../agents/mesh";
import { createMesh } from "../agents/mesh";
import type { AgentModel, ModelRoute } from "../agents/model";
import type { AgentCompatibilityRegistry } from "../agents/registry";
import { createAgentCompatibilityRegistry } from "../agents/registry";
import type { AgentAuthorizer } from "../authorization/authorization";
import { effectiveLimit, resolveBudget } from "../contexts/budget";
import { cacheDirectivesFor, mergeProviderOptions } from "../contexts/cache";
import { estimatingCounter } from "../contexts/counter";
import type { SessionWindowOptions, WindowModel } from "../contexts/types";
import type { Summarizer } from "../session/compactor";
import { maybeCompact } from "../session/compactor";
import {
  toModelMessages,
  validateApprovalResponse,
} from "../session/converter";
import type {
  SessionInput,
  SessionStream,
  StreamHandlers,
} from "../session/events";
import type { SessionStore, SummarizableStore } from "../session/store";
import { InMemorySessionStore } from "../session/store";
import type {
  SessionMessage,
  SessionPart,
  SessionRole,
} from "../session/types";
import { composeTools } from "../tools/compose";
import type { AgentHarnessSettings } from "./agent-harness";
import { AgentHarness } from "./agent-harness";
import type { StreamSource } from "./stream-transform";
import { transformStream } from "./stream-transform";

export type SessionHarnessSettings = AgentHarnessSettings & {
  /** Where the session's messages persist. In memory when omitted. */
  store?: SessionStore;
  /** Agent registry for multi-agent routing. Auto-created when omitted. */
  registry?: AgentCompatibilityRegistry;
  /** Mesh for inter-agent communication. Auto-created when omitted. */
  mesh?: Mesh;
  /** Node id for this harness in the mesh (defaults to "primary"). */
  nodeId?: string;
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
 * An {@link AgentHarness} run as a persisted session: each turn appends its
 * input, replays the session's history to the agent, and commits the assistant
 * reply — all on top of {@link transformStream}. The session id is fixed at
 * construction (adopted or minted), and the session is created in the store on
 * the first turn if it does not exist yet.
 */
export class SessionHarness {
  readonly agent: LoopAgent;
  readonly model: AgentModel;
  readonly route: ModelRoute;
  readonly policy: AgentAuthorizer;
  readonly agentId: string;
  readonly agentGeneration?: number;
  readonly sessionId: string;
  readonly store: SessionStore;
  readonly registry: AgentCompatibilityRegistry;
  readonly mesh: Mesh;
  readonly nodeId: string;
  readonly #harness: AgentHarness;
  readonly #compaction: CompactionSettings | undefined;
  /** Settles once the session is known to exist in the store. */
  #sessionReady: Promise<void> | undefined;
  /** Construction-time providerOptions, merged under per-turn cache directives. */
  readonly #baseProviderOptions:
    | Record<string, Record<string, unknown>>
    | undefined;

  constructor(settings: SessionHarnessSettings, context?: TurnContext) {
    const {
      store = new InMemorySessionStore(),
      registry = createAgentCompatibilityRegistry(),
      mesh = createMesh({ registry, store }),
      nodeId = "primary",
      compaction,
      tools,
      ...harnessSettings
    } = settings;

    // Mesh tools carry `source: "mesh"` on themselves, so the compiler keeps
    // that attribution for policy and audit even though they share one map.
    const harness = new AgentHarness(
      {
        ...harnessSettings,
        // Persisted summaries and host notifications are trusted system history.
        // AI SDK v7 rejects them in messages unless this is explicit.
        allowSystemInMessages: true,
        tools: composeTools(tools, mesh.tools(nodeId)),
      },
      context
    );
    this.#harness = harness;
    this.agent = harness.agent;
    this.model = harness.model;
    this.route = harness.route;
    this.policy = harness.policy;
    this.agentId = harness.agentId;
    this.agentGeneration = harness.agentGeneration;
    this.sessionId = harness.sessionId;
    this.store = store;
    this.registry = registry;
    this.mesh = mesh;
    this.nodeId = nodeId;
    this.#compaction = compaction;
    this.#baseProviderOptions = settings.providerOptions;
  }

  stream(
    input: SessionInput,
    options: SessionStreamOptions = {}
  ): SessionStream {
    // Set once the input is in the store: a turn rejected before then (a bad
    // approval response) must leave the session untouched, error reply included.
    let appended = false;

    const source: StreamSource = (async () => {
      const inputParts = normalizeInput(input);
      await this.#validateApprovalResponses(inputParts);
      await this.#ensureSession();
      await this.store.appendMessage({
        parts: inputParts,
        role: inputRole(inputParts),
        sessionId: this.sessionId,
      });
      appended = true;
      await this.#maybeCompact();
      const history = await readContext(this.store, this.sessionId);
      const messages = await toModelMessages(history, this.agent.tools);
      const providerOptions = this.#applyCacheDirectives(messages);

      const { parts } = await this.#harness.stream({
        abortSignal: options.signal,
        messages,
        // A call's options are spread over the agent's settings, so an
        // explicit `undefined` would erase the construction-time options.
        ...(providerOptions ? { providerOptions } : {}),
      });
      return parts;
    })();

    const commit = (message: SessionMessage): Promise<SessionMessage> => {
      const { sessionId } = this;
      if (!appended) {
        return Promise.resolve({ ...message, sessionId });
      }
      return this.store
        .appendMessage({
          metadata: message.metadata,
          parts: message.parts,
          role: "assistant",
          sessionId,
          status: message.status,
        })
        .catch(() => ({ ...message, sessionId }));
    };

    return transformStream(source, {
      commit,
      handlers: options,
      model: this.route,
    });
  }

  generate(
    input: SessionInput,
    options: SessionStreamOptions = {}
  ): Promise<SessionMessage> {
    return this.stream(input, options).message;
  }

  /**
   * Apply this turn's provider cache directives (contexts/cache). Mutates
   * `messages` to mark the Anthropic `cacheControl` breakpoint on the last
   * (appended-only, therefore now-stable) message, and returns the request-level
   * options (OpenAI `promptCacheKey` / Google `cachedContent`) merged over the
   * agent's construction-time `providerOptions`. No-ops when the provider/model
   * is unknown; OpenAI/Google otherwise ride the stable prefix for free.
   */
  #applyCacheDirectives(
    messages: ModelMessage[]
  ): ProviderMetadata | undefined {
    const directives = cacheDirectivesFor({
      modelId: this.route.id,
      provider: this.route.provider,
      sessionId: this.sessionId,
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
  async #maybeCompact(): Promise<void> {
    const c = this.#compaction;
    const store = asSummarizable(this.store);
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
      await maybeCompact(store, c.summarizer, this.sessionId, {
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
   * from it. Uses whatever history already exists for this session (none
   * before its first turn), never the input being validated.
   */
  async #validateApprovalResponses(parts: SessionPart[]): Promise<void> {
    const responses = parts.filter(
      (p): p is Extract<SessionPart, { type: "tool_approval_response" }> =>
        p.type === "tool_approval_response"
    );
    if (responses.length === 0) {
      return;
    }
    const history = await this.store.listMessages(this.sessionId);
    for (const response of responses) {
      validateApprovalResponse(history, response);
    }
  }

  /** Create the session under its fixed id unless the store already has it —
   *  a host may adopt an id it filed itself. Checked once per harness; a
   *  failed check is retried on the next turn. */
  #ensureSession(): Promise<void> {
    this.#sessionReady ??= this.#createSessionIfMissing().catch(
      (error: unknown) => {
        this.#sessionReady = undefined;
        throw error;
      }
    );
    return this.#sessionReady;
  }

  async #createSessionIfMissing(): Promise<void> {
    if (!(await this.store.getSession(this.sessionId))) {
      await this.store.createSession({ id: this.sessionId });
    }
  }
}

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
