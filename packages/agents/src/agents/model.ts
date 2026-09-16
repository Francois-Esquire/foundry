import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { TelemetryOptions } from "ai";

/**
 * How the host names a model: the ids recorded on every message so a session
 * resumes on the same route. `id` is the host's catalog id, which may differ
 * from the wire `modelId`; `provider` and `harness` are the host's routing
 * ids, not the SDK provider name.
 */
export interface ModelRoute {
  readonly harness?: string;
  readonly id: string;
  readonly provider?: string;
}

export interface ModelLimits {
  /** Max input tokens. */
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
}

/**
 * A language model as an agent takes it: the AI SDK model plus the facts the
 * harness reads off it. Both facts are optional, so a raw SDK model works and
 * a host registry hands back one that knows its route and window.
 */
export interface AgentModel extends LanguageModelV4 {
  readonly limits?: ModelLimits;
  readonly route?: ModelRoute;
}

/** The route recorded for a model: its declared one, else what the SDK model says about itself. */
export function routeOf(model: AgentModel): ModelRoute {
  return model.route ?? { id: model.modelId, provider: model.provider };
}

/** One turn's wide observation event. A host supplies these through {@link ObserveTurn}. */
export interface TurnObservation {
  /** Settle the event. Idempotent; pass an error to record it. */
  emit: (error?: unknown) => void;
  /** Telemetry for the agent call, sharing this turn's event. */
  telemetry: TelemetryOptions;
  /** Wrap the turn's model so its calls record into this turn's event. */
  wrap: (model: LanguageModelV4) => LanguageModelV4;
}

/** Opens a turn observation, or `null` to run the turn unobserved. */
export type ObserveTurn = (turn: {
  readonly sessionId: string;
  readonly model: ModelRoute;
}) => TurnObservation | null;
