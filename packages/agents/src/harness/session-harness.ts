import type { ModelMessage, Output, ProviderMetadata } from "ai";

import type {
  LoopAgent,
  TurnCallSettings,
  TurnContext,
} from "../agents/loop-agent";
import { TURN_SETTINGS } from "../agents/loop-agent";
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
import { Sessions } from "../session/sessions";
import type {
  SessionMessage,
  SessionPart,
  SessionRole,
} from "../session/types";
import type { SessionStore } from "../store";
import { MemorySessionStore } from "../store/memory";
import { composeTools } from "../tools/compose";
import type { AgentHarnessSettings } from "./agent-harness";
import { AgentHarness } from "./agent-harness";
import type { StreamSource } from "./stream-transform";
import { transformStream } from "./stream-transform";

export type SessionHarnessSettings = AgentHarnessSettings & {
  store?: SessionStore;
  registry?: AgentCompatibilityRegistry;
  mesh?: Mesh;
  nodeId?: string;
  compaction?: CompactionSettings;
};

export interface CompactionSettings {
  keepTokens?: number;
  model?: WindowModel;
  summarizer: Summarizer;
  window?: SessionWindowOptions;
}

const DEFAULT_COMPACTION_HIGH_WATER = 0.8;

export type TurnOptions<OUTPUT extends Output.Output = never> =
  TurnCallSettings<OUTPUT> &
    StreamHandlers & {
      signal?: AbortSignal;
    };

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
  readonly #sessions: Sessions;
  readonly #compaction: CompactionSettings | undefined;
  #sessionReady: Promise<void> | undefined;
  readonly #baseProviderOptions:
    | Record<string, Record<string, unknown>>
    | undefined;

  constructor(settings: SessionHarnessSettings, context?: TurnContext) {
    const {
      store = new MemorySessionStore(),
      registry = createAgentCompatibilityRegistry(),
      mesh = createMesh({ registry, store }),
      nodeId = "primary",
      compaction,
      tools,
      ...harnessSettings
    } = settings;

    const harness = new AgentHarness(
      {
        ...harnessSettings,
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
    this.#sessions = new Sessions({ store });
    this.registry = registry;
    this.mesh = mesh;
    this.nodeId = nodeId;
    this.#compaction = compaction;
    this.#baseProviderOptions = settings.providerOptions;
  }

  stream<OUTPUT extends Output.Output = never>(
    input: SessionInput,
    options: TurnOptions<OUTPUT> = {}
  ): SessionStream<OUTPUT> {
    let appended = false;

    const started = (async () => {
      const inputParts = normalizeInput(input);
      await this.#validateApprovalResponses(inputParts);
      await this.#ensureSession();
      await this.#sessions.appendMessage({
        parts: inputParts,
        role: inputRole(inputParts),
        sessionId: this.sessionId,
      });
      appended = true;
      await this.#maybeCompact();
      const history = await this.#sessions.activeMessages(this.sessionId);
      const messages = await toModelMessages(history, this.agent.tools);
      const providerOptions = this.#applyCacheDirectives(
        messages,
        options.providerOptions
      );

      return this.#harness.stream<OUTPUT>({
        abortSignal: options.signal,
        messages,
        ...turnSettings(options),
        ...(providerOptions ? { providerOptions } : {}),
      });
    })();
    const source: StreamSource = started.then(({ parts }) => parts);

    const commit = (message: SessionMessage): Promise<SessionMessage> => {
      const { sessionId } = this;
      if (!appended) {
        return Promise.resolve({ ...message, sessionId });
      }
      return this.#sessions.appendMessage({
        metadata: message.metadata,
        parts: message.parts,
        role: "assistant",
        sessionId,
        status: message.status,
      });
    };

    return transformStream(source, {
      commit,
      handlers: options,
      model: this.route,
      sessionId: this.sessionId,
      ...(options.output ? { output: options.output } : {}),
      result: started.then(
        ({ result }) => result,
        () => undefined
      ),
    });
  }

  generate<OUTPUT extends Output.Output = never>(
    input: SessionInput,
    options: TurnOptions<OUTPUT> = {}
  ): Promise<SessionMessage> {
    return this.stream(input, options).message;
  }

  #applyCacheDirectives(
    messages: ModelMessage[],
    turn: ProviderMetadata | undefined
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

    const base = turn
      ? mergeProviderOptions(this.#baseProviderOptions, turn)
      : this.#baseProviderOptions;
    if (!directives.request) {
      return turn ? (base as ProviderMetadata | undefined) : undefined;
    }
    return mergeProviderOptions(base, directives.request) as
      | ProviderMetadata
      | undefined;
  }

  async #maybeCompact(): Promise<void> {
    const c = this.#compaction;
    if (!c) {
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
      await maybeCompact(this.store, c.summarizer, this.sessionId, {
        counter,
        keepTokens,
        limit,
      });
    } catch {
      return undefined;
    }
  }

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
    if (!(await this.#sessions.getSession(this.sessionId))) {
      await this.#sessions.createSession({ id: this.sessionId });
    }
  }
}

function turnSettings<OUTPUT extends Output.Output>(
  options: TurnOptions<OUTPUT>
): TurnCallSettings<OUTPUT> {
  const settings: Record<string, unknown> = {};
  for (const key of [...TURN_SETTINGS, "output"] as const) {
    if (options[key] !== undefined) {
      settings[key] = options[key];
    }
  }
  return settings as TurnCallSettings<OUTPUT>;
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
