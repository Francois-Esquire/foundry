/**
 * `SessionWindow` — a {@link SessionStore} decorator that adds context-window
 * management without breaking any store consumer.
 *
 * It **wraps an injected store** (composition, not inheritance) and delegates
 * all six `SessionStore` methods verbatim, so it's a drop-in anywhere a
 * `SessionStore` is expected — including the default {@link InMemorySessionStore}.
 * In particular `listMessages` stays a faithful raw passthrough (full history,
 * insertion order), because the transcript UI and persistence depend on that
 * contract.
 *
 * The managed/fitted view is an **additive** surface: {@link windowFor} returns
 * the sized message list for a turn. The deferred harness integration is the one
 * caller that opts into `windowFor` instead of `listMessages`.
 */
import type {
  CreateMessageInput,
  CreateSessionInput,
  SessionStore,
  UpdateMessageInput,
  UpdateSessionInput,
} from "../session/store";
import type { SessionMessage, SessionRecord } from "../session/types";
import { effectiveLimit, resolveBudget } from "./budget";
import { estimatingCounter } from "./counter";
import { prepareContext } from "./prepare";
import type {
  SessionUsage,
  SessionWindowOptions,
  TokenCounter,
  WindowModel,
  WindowResult,
  WindowState,
} from "./types";

const DEFAULT_HIGH_WATER_RATIO = 0.8;

export class SessionWindow implements SessionStore {
  readonly #store: SessionStore;
  readonly #counter: TokenCounter;
  readonly #options: SessionWindowOptions;
  readonly #highWaterRatio: number;
  /** Ephemeral per-session bookkeeping (context.md §2). Not persisted yet. */
  readonly #state = new Map<string, WindowState>();

  constructor(store: SessionStore, options: SessionWindowOptions = {}) {
    this.#store = store;
    this.#options = options;
    this.#counter = options.counter ?? estimatingCounter;
    this.#highWaterRatio = options.highWaterRatio ?? DEFAULT_HIGH_WATER_RATIO;
  }

  createSession(input?: CreateSessionInput): Promise<SessionRecord> {
    return this.#store.createSession(input);
  }

  getSession(id: string): Promise<SessionRecord | null> {
    return this.#store.getSession(id);
  }

  updateSession(
    id: string,
    patch: UpdateSessionInput
  ): Promise<SessionRecord | null> {
    return this.#store.updateSession(id, patch);
  }

  appendMessage(input: CreateMessageInput): Promise<SessionMessage> {
    return this.#store.appendMessage(input);
  }

  updateMessage(
    id: string,
    patch: UpdateMessageInput
  ): Promise<SessionMessage | null> {
    return this.#store.updateMessage(id, patch);
  }

  /** Raw history, insertion order — the unchanged `SessionStore` contract. */
  listMessages(sessionId: string): Promise<SessionMessage[]> {
    return this.#store.listMessages(sessionId);
  }

  /**
   * The managed view for a turn: full history sized against the model's budget.
   * Phase 1 returns the history unchanged (behavior-preserving) and reports the
   * budget/plan; the fit grows behind this signature.
   */
  async windowFor(
    sessionId: string,
    model: WindowModel
  ): Promise<WindowResult> {
    const history = await this.#store.listMessages(sessionId);
    const budget = resolveBudget(model, this.#options);
    const limit = effectiveLimit(budget, this.#highWaterRatio);
    const { messages, plan } = prepareContext({
      budget,
      counter: this.#counter,
      history,
      limit,
    });
    return { budget, messages, plan };
  }

  /**
   * Feed back the provider's reported usage after a turn (context.md §2): the
   * actuals are the source of truth, and the turn-to-turn diff is the growth
   * `velocity` stat we keep for later.
   */
  recordUsage(sessionId: string, usage: SessionUsage): void {
    const prev = this.#state.get(sessionId);
    const velocity =
      prev?.lastInputTokens === undefined
        ? undefined
        : usage.inputTokens - prev.lastInputTokens;
    this.#state.set(sessionId, {
      lastEstimate: prev?.lastEstimate,
      lastInputTokens: usage.inputTokens,
      ...(velocity === undefined ? {} : { velocity }),
    });
  }

  /** Current ephemeral bookkeeping for a session, if any. */
  stateFor(sessionId: string): WindowState | undefined {
    return this.#state.get(sessionId);
  }

  /** The wrapped store, for callers that need the raw seam. */
  get inner(): SessionStore {
    return this.#store;
  }
}
