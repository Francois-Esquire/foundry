import type { LanguageModelV4 } from "@ai-sdk/provider";
import type {
  ObserveTurn,
  TurnObservation,
} from "@foundry/agents/agents/model";
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

// evlog's `wrap` accepts a gateway model id and every provider spec, so it
// returns `string | LanguageModelV4 | LanguageModelV3 | LanguageModelV2`.
// Providers hand it a v4 model object and get that same object back, so narrow
// here — widening `ModelManager.model()` instead would push the union onto every
// caller in agents, studio, and chat.
const wrapModel =
  (ai: AILogger) =>
  (model: LanguageModelV4): LanguageModelV4 => {
    const wrapped = ai.wrap(model);
    return typeof wrapped === "string" || wrapped.specificationVersion !== "v4"
      ? model
      : wrapped;
  };

let enabled = true;
/** Per-1M-token list prices keyed by wire model id; the manager fills it from catalogs. */
let costMap: Record<string, ModelCost> = {};

export interface ModelObservabilityOptions {
  /** Per-1M-token pricing, merged over what catalogs have reported so far. */
  cost?: Record<string, ModelCost>;
  /** Turn capture on or off process-wide. Defaults to enabled. */
  enabled?: boolean;
  /** Forwarded to evlog's `initLogger` — drain, sampling, redaction, etc. */
  logger?: LoggerConfig;
}

/**
 * App-level, call-once configuration. The library never invokes this itself;
 * the host (e.g. Electron main) calls it at startup to wire a drain, adjust
 * pricing, or disable capture. Passing `logger` runs evlog's global
 * `initLogger`, which must happen exactly once per process.
 */
export function configureModelObservability(
  options: ModelObservabilityOptions = {}
): void {
  if (options.enabled !== undefined) {
    enabled = options.enabled;
  }
  if (options.cost) {
    costMap = { ...costMap, ...options.cost };
  }
  if (options.logger) {
    initLogger(options.logger);
  }
}

/** Whether AI capture is currently active. */
export function isModelObservabilityEnabled(): boolean {
  return enabled;
}

/**
 * A turn-scoped observation: one evlog wide event spanning a whole tool-loop
 * turn, exposed as three handles that all draw on a single `createAILogger`
 * accumulator. Returned by {@link beginTurnObservation}. The shape is the
 * agent package's own, so a host hands {@link observeAgentTurn} straight to
 * an agent surface.
 *
 * Splitting the handles is deliberate: they're consumed in different layers,
 * but they MUST share one accumulator or the model-level and agent-level
 * captures clobber each other's `ai` field. So we build the accumulator once
 * here and hand out `wrap` (the model: token usage / cost), `telemetry` (the
 * `ToolLoopAgent`: tool executions + total duration), and `emit` (the harness:
 * settling at the turn boundary the evlog library can't see).
 */
export type { TurnObservation };

/**
 * Open a turn-scoped {@link TurnObservation}, or `null` when observability is
 * disabled (callers run raw — zero cost). The harness calls this per turn,
 * threads `wrap` down to `manager.model` and `telemetry` onto the agent, and
 * `emit`s at the turn's settle/catch.
 */
export function beginTurnObservation(
  context: Record<string, unknown> = {}
): TurnObservation | null {
  if (!enabled) {
    return null;
  }

  const log = createLogger({ ...context, task: "models.inference" });
  const ai = createAILogger(log, { cost: costMap });
  // Built once over the single accumulator, so it shares state with `wrap`.
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

/** {@link beginTurnObservation} in the shape an agent surface takes. */
export const observeAgentTurn: ObserveTurn = ({ sessionId, model }) =>
  beginTurnObservation({
    model: model.id,
    sessionId,
    ...(model.provider ? { provider: model.provider } : {}),
  });

/**
 * Run an AI-SDK operation inside an evlog wide event.
 *
 * Creates a fresh request logger scoped to `context`, builds the capture
 * session over it, runs `fn`, and emits the wide event once `fn` settles —
 * success or failure — so usage and errors are never dropped. Returns whatever
 * `fn` returns. When observability is disabled, `fn` runs against a no-op
 * session and no event is emitted.
 */
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

interface InitEventFields {
  init: Record<string, unknown>;
  provider: string;
  task: string;
}

export interface InitLogSession {
  end: (error?: unknown) => void;
  set: (fields: Record<string, unknown>) => void;
}

const NOOP_INIT_SESSION: InitLogSession = {
  end: () => undefined,
  set: () => undefined,
};

export function beginInitLog(provider: string): InitLogSession {
  if (!enabled) {
    return NOOP_INIT_SESSION;
  }

  const log = createLogger<InitEventFields>({
    init: {},
    provider,
    task: "models.init",
  });
  let ended = false;
  return {
    end: (error) => {
      if (ended) {
        return;
      }
      ended = true;
      if (error !== undefined) {
        log.error(coerceError(error));
      }
      log.emit();
    },
    set: (fields) => {
      log.set({ init: fields });
    },
  };
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

export interface DownloadTick {
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

/** Typed evlog fields for a download wide event. */
interface DownloadEventFields {
  download: Record<string, unknown>;
  task: string;
}

/**
 * The canonical evlog lifecycle applied to a download: open the logger at the
 * first real network tick (cache loads never open one, so they stay silent),
 * `set()` per-file context as files complete, and emit exactly once with the
 * audit attached — evlog stamps the event with the real start-to-emit
 * duration. transformers-js fires a terminal `done` per file (plus `ready`
 * for the model), so emitting on every terminal would scatter N bare audits
 * across one download; the latch + all-files-complete gate in `finish`
 * collapses that to a single event carrying the whole story.
 */
class DownloadTraceImpl implements ModelDownloadTrace {
  private readonly files = new Map<string, TraceFile>();
  private log: ReturnType<typeof createLogger<DownloadEventFields>> | null =
    null;
  private startedAt: number | null = null;
  private ended = false;

  constructor(private readonly target: ModelDownloadTarget) {}

  track(tick: DownloadTick): void {
    // Only a real fetch streams sub-100% byte progress; cache loads jump
    // straight to terminal events. The first such tick opens the event.
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
    // Fold each finished file into the live event as it lands, so the event
    // carries partial context mid-flight instead of being assembled at the
    // end.
    if (complete && prev?.complete !== true) {
      this.log?.set({ download: this.summary() });
    }
  }

  /**
   * End the wide event at this terminal marker if the download is truly over.
   * `ready` is the model-level all-done signal; a file-level terminal only
   * counts once every tracked file has completed, so the first small file's
   * `done` doesn't end the event while weights still stream. At most one
   * emission per trace.
   */
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

  /** Aggregate stats so far: per-file bytes, totals, elapsed time. */
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

/**
 * Start tracing one model download as a single wide event. Create a trace per
 * progress-callback binding, hand it every tick via `track`, and call
 * `finish` at terminal markers — the trace decides when (and whether) the
 * event opens and ends. Returns a no-op when observability is disabled, so
 * the download path pays nothing.
 */
export function traceModelDownload(
  target: ModelDownloadTarget
): ModelDownloadTrace {
  if (!enabled) {
    return NOOP_DOWNLOAD_TRACE;
  }
  return new DownloadTraceImpl(target);
}
