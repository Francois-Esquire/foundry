/** Wraps a session store and provides a separate context estimate for a turn. */
import type { SessionMessage, SessionRecord } from "../session/types";
import type { SessionStore, SessionStoreWrite } from "../store";
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
  readonly #state = new Map<string, WindowState>();

  constructor(store: SessionStore, options: SessionWindowOptions = {}) {
    this.#store = store;
    this.#options = options;
    this.#counter = options.counter ?? estimatingCounter;
    this.#highWaterRatio = options.highWaterRatio ?? DEFAULT_HIGH_WATER_RATIO;
  }

  commit(write: SessionStoreWrite): Promise<void> {
    return this.#store.commit(write);
  }

  getMessage(id: string): Promise<SessionMessage | null> {
    return this.#store.getMessage(id);
  }

  getSession(id: string): Promise<SessionRecord | null> {
    return this.#store.getSession(id);
  }

  /** Raw history, insertion order — the unchanged `SessionStore` contract. */
  listMessages(sessionId: string): Promise<SessionMessage[]> {
    return this.#store.listMessages(sessionId);
  }

  /**
   * Return the history and its current fit estimate for a turn. The fit
   * currently keeps the full history unchanged.
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
   * Store provider-reported usage for the session.
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
      velocity,
    });
  }

  stateFor(sessionId: string): WindowState | undefined {
    return this.#state.get(sessionId);
  }

  get inner(): SessionStore {
    return this.#store;
  }
}
