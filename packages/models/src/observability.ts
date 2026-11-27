import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { ObserveTurn, TurnObservation } from "@foundry/core/agents";
import type { TelemetryOptions } from "ai";
import type { LoggerConfig } from "evlog";

import { createLogger, initLogger } from "evlog";
import type { AILogger, ModelCost } from "evlog/ai";
import { createAILogger, createEvlogIntegration } from "evlog/ai";

const wrapModel =
  (ai: AILogger) =>
  (model: LanguageModelV4): LanguageModelV4 => {
    const wrapped = ai.wrap(model);
    return typeof wrapped === "string" || wrapped.specificationVersion !== "v4"
      ? model
      : wrapped;
  };

let enabled = true;
let costMap: Record<string, ModelCost> = {};

export interface ModelObservabilityOptions {
  cost?: Record<string, ModelCost>;
  enabled?: boolean;
  logger?: LoggerConfig;
}

export function configureModelObservability(
  options: ModelObservabilityOptions = {}
): void {
  if (options.enabled !== undefined) {
    ({ enabled } = options);
  }
  if (options.cost) {
    costMap = { ...costMap, ...options.cost };
  }
  if (options.logger) {
    initLogger(options.logger);
  }
}

export function isModelObservabilityEnabled(): boolean {
  return enabled;
}

export type { TurnObservation } from "@foundry/core/agents";

export function beginTurnObservation(
  context: Record<string, unknown> = {}
): TurnObservation | null {
  if (!enabled) {
    return null;
  }

  const log = createLogger({ ...context, task: "models.inference" });
  const ai = createAILogger(log, { cost: costMap });
  const telemetry: TelemetryOptions = {
    integrations: [createEvlogIntegration(ai)],
    isEnabled: true,
  };
  let ended = false;
  return {
    emit: (error) => {
      if (ended) {
        return;
      }
      ended = true;
      if (error !== undefined) {
        log.error(coerceError(error));
      }
      log.emit();
    },
    telemetry,
    wrap: wrapModel(ai),
  };
}

export const observeAgentTurn: ObserveTurn = ({ sessionId, model }) =>
  beginTurnObservation({
    model: model.id,
    sessionId,
    ...(model.provider ? { provider: model.provider } : {}),
  });

function coerceError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === "string" ? error : JSON.stringify(error));
}
