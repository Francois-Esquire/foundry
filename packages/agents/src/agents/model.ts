import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { TelemetryOptions } from "ai";

export interface ModelRoute {
  readonly harness?: string;
  readonly id: string;
  readonly provider?: string;
}

export interface ModelLimits {
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
}

export interface AgentModel extends LanguageModelV4 {
  readonly limits?: ModelLimits;
  readonly route?: ModelRoute;
}

export function routeOf(model: AgentModel): ModelRoute {
  return model.route ?? { id: model.modelId, provider: model.provider };
}

export interface TurnObservation {
  emit: (error?: unknown, outcome?: "cancelled") => void;
  telemetry: TelemetryOptions;
  wrap: (model: LanguageModelV4) => LanguageModelV4;
}

export type ObserveTurn = (turn: {
  readonly sessionId: string;
  readonly model: ModelRoute;
}) => TurnObservation | null;
