import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { ObserveTurn, TurnObservation } from "@foundry/core/agents";
import type { TelemetryOptions } from "ai";
import type { AuditActor, AuditInput, LoggerConfig } from "evlog";

import { createLogger, initLogger } from "evlog";
import type { AILogger, ModelCost } from "evlog/ai";
import { createAILogger, createEvlogIntegration } from "evlog/ai";

import { modelAudit } from "./audit";

export interface AiLoggerSession {
  captureEmbed: AILogger["captureEmbed"];
  wrap: (model: LanguageModelV4) => LanguageModelV4;
}

const NOOP_SESSION: AiLoggerSession = {
  captureEmbed: () => undefined,
  wrap: (model) => model,
};

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

export async function withAiLogger<T>(
  context: Record<string, unknown>,
  fn: (session: AiLoggerSession) => Promise<T>
): Promise<T> {
  if (!enabled) {
    return fn(NOOP_SESSION);
  }

  const log = createLogger({ ...context, task: "models.inference" });
  const ai = createAILogger(log, { cost: costMap });
  try {
    return await fn({ captureEmbed: ai.captureEmbed, wrap: wrapModel(ai) });
  } finally {
    log.emit();
  }
}

function coerceError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === "string" ? error : JSON.stringify(error));
}

export const SYSTEM_ACTOR: AuditActor = { id: "models", type: "system" };

export function recordAudit(
  input: AuditInput,
  context: Record<string, unknown> = {}
): void {
  if (!enabled) {
    return;
  }

  const log = createLogger(context);
  log.audit(input);
  log.emit();
}

export interface ModelDownloadTarget {
  dtype?: string;
  kind: string;
  label?: string;
  modelId: string;
}

interface DownloadTick {
  file?: string;
  loaded?: number;
  progress?: number;
  status: string;
  total?: number;
}

export interface ModelDownloadTrace {
  finish: (status: string) => void;
  track: (tick: DownloadTick) => void;
}

interface TraceFile {
  complete: boolean;
  loaded: number;
  total: number;
}

interface DownloadEventFields {
  download: Record<string, unknown>;
  task: string;
}

class DownloadTraceImpl implements ModelDownloadTrace {
  private readonly files = new Map<string, TraceFile>();
  private readonly target: ModelDownloadTarget;
  private log: ReturnType<typeof createLogger<DownloadEventFields>> | null =
    null;
  private startedAt: number | null = null;
  private ended = false as boolean;

  constructor(target: ModelDownloadTarget) {
    this.target = target;
  }

  track(tick: DownloadTick): void {
    if (
      this.log === null &&
      tick.status === "progress" &&
      typeof tick.progress === "number" &&
      tick.progress < 100
    ) {
      this.startedAt = Date.now();
      this.log = createLogger<DownloadEventFields>({
        download: this.identity(),
        task: "models.download",
      });
    }
    if (!tick.file) {
      return;
    }
    const prev = this.files.get(tick.file);
    const complete =
      prev?.complete === true ||
      tick.status === "done" ||
      (typeof tick.progress === "number" && tick.progress >= 100);
    this.files.set(tick.file, {
      complete,
      loaded: tick.loaded ?? prev?.loaded ?? 0,
      total: tick.total ?? prev?.total ?? 0,
    });
    if (complete && prev?.complete !== true) {
      this.log?.set({ download: this.summary() });
    }
  }

  finish(status: string): void {
    if (this.ended || this.log === null) {
      return;
    }
    if (status !== "ready") {
      for (const f of this.files.values()) {
        if (!f.complete) {
          return;
        }
      }
    }
    this.ended = true;
    this.log.set({ download: { ...this.identity(), ...this.summary() } });
    this.log.audit(
      modelAudit.MODEL_DOWNLOAD({
        actor: SYSTEM_ACTOR,
        target: { id: this.target.modelId },
      })
    );
    this.log.emit();
  }

  private identity(): Record<string, unknown> {
    return {
      modelId: this.target.modelId,
      ...(this.target.label ? { label: this.target.label } : {}),
      kind: this.target.kind,
      ...(this.target.dtype ? { dtype: this.target.dtype } : {}),
    };
  }

  private summary(): Record<string, unknown> {
    let totalBytes = 0;
    const files: { file: string; bytes: number }[] = [];
    for (const [file, f] of this.files) {
      const bytes = f.total > 0 ? f.total : f.loaded;
      totalBytes += bytes;
      files.push({ bytes, file });
    }
    return {
      fileCount: files.length,
      files,
      totalBytes,
      ...(this.startedAt === null
        ? {}
        : { durationMs: Date.now() - this.startedAt }),
    };
  }
}

const NOOP_DOWNLOAD_TRACE: ModelDownloadTrace = {
  finish: () => undefined,
  track: () => undefined,
};

export function traceModelDownload(
  target: ModelDownloadTarget
): ModelDownloadTrace {
  if (!enabled) {
    return NOOP_DOWNLOAD_TRACE;
  }
  return new DownloadTraceImpl(target);
}
