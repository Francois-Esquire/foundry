import { EventEmitter } from "node:events";
import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  EmbeddingModelV4,
  LanguageModelV4,
  TranscriptionModelV4,
} from "@ai-sdk/provider";
import { transformersJS } from "@browser-ai/transformers-js";
import type { ProgressInfo } from "@huggingface/transformers";
import { env, pipeline } from "@huggingface/transformers";
import {
  embed,
  extractReasoningMiddleware,
  generateText,
  wrapLanguageModel,
} from "ai";
import { withLocalCosts } from "../catalog/local";
import { modelErrors } from "../errors";
import type { ModelDownloadTarget } from "../logger";
import { traceModelDownload } from "../logger";
import { resolveDefinition } from "../provider";
import type {
  ModelKind,
  TranscribeInput,
  TranscribeOptions,
  TranscribeResult,
  TranscribeSegment,
} from "../types";
import type {
  LocalDownloadProgress,
  LocalFileProgress,
  LocalLoadedModel,
  LocalLoadState,
  LocalLoadStatus,
  LocalModelDefinition,
  LocalProviderSurface,
} from "./surface";

let configured = false;

export function configureCache(cacheDir: string): void {
  if (configured) {
    return;
  }
  env.cacheDir = cacheDir;
  env.allowLocalModels = true;
  env.allowRemoteModels = true;
  configured = true;
}

interface AsrOutput {
  chunks?: { timestamp?: [number | null, number | null]; text?: string }[];
  text: string;
}

type AsrPipe = (
  audio: Float32Array,
  opts: { language?: string; return_timestamps?: boolean }
) => Promise<AsrOutput>;

// The Qwen rows declare tool-calling + reasoning: the transformers-js adapter
// wires function tools through their chat template, and Qwen3 emits `<think>`
// reasoning (peeled by the middleware in languageModel). The SmolLM2 rows stay
// undeclared — no reliable tool calling — which keeps them out of surfaces
// that require it (e.g. the chat picker's functionCalling filter).
export const LOCAL_DEFAULT_MODELS: LocalModelDefinition[] = [
  {
    capabilities: { functionCalling: true, reasoning: true },
    id: "text",
    kind: "text",
    label: "Qwen3.5 0.8B",
    limits: { maxInputTokens: 32_768 },
    modelId: "onnx-community/Qwen3.5-0.8B-Text-ONNX",
    settings: { dtype: "q4f16" },
  },
  {
    capabilities: { functionCalling: true, reasoning: true },
    id: "text-alt",
    kind: "text",
    label: "Qwen3 0.6B",
    limits: { maxInputTokens: 32_768 },
    modelId: "onnx-community/Qwen3-0.6B-ONNX",
    settings: { dtype: "q4f16" },
  },
  {
    capabilities: { functionCalling: true, reasoning: true },
    id: "text-large",
    kind: "text",
    label: "Qwen3 1.7B",
    limits: { maxInputTokens: 32_768 },
    modelId: "onnx-community/Qwen3-1.7B-ONNX",
    settings: { dtype: "q4f16" },
  },
  {
    id: "text-small",
    kind: "text",
    label: "SmolLM2 360M Instruct",
    limits: { maxInputTokens: 8192 },
    modelId: "HuggingFaceTB/SmolLM2-360M-Instruct",
    settings: { dtype: "q4" },
  },
  {
    id: "text-tiny",
    kind: "text",
    label: "SmolLM2 135M Instruct",
    limits: { maxInputTokens: 8192 },
    modelId: "HuggingFaceTB/SmolLM2-135M-Instruct",
    settings: { dtype: "q4" },
  },
  {
    dimensions: 384,
    id: "embed",
    kind: "embedding",
    label: "all-MiniLM-L6-v2",
    modelId: "Xenova/all-MiniLM-L6-v2",
  },
  {
    id: "transcribe",
    kind: "transcription",
    label: "Whisper Base (English)",
    modelId: "Xenova/whisper-base.en",
  },
];

/**
 * Temporarily pointed at Qwen3 0.6B (`text-alt`) while diagnosing markdown
 * `<think>`-eating and missing tool-call behavior on the 0.8B `text` row.
 * Flip back to `"text"` once fixed.
 */
export const LOCAL_DEFAULTS: Partial<Record<ModelKind, string>> = {
  embedding: "embed",
  text: "text-alt",
  transcription: "transcribe",
};

export interface LocalProviderOptions {
  defaults?: Partial<Record<ModelKind, string>>;
  id?: string;
  models?: LocalModelDefinition[];
}

/** Logging identity for a download — who its wide event is about. */
function downloadTarget(def: LocalModelDefinition): ModelDownloadTarget {
  const dtype = dtypeOf(def);
  return {
    modelId: def.modelId,
    ...(def.label ? { label: def.label } : {}),
    kind: def.kind ?? "text",
    ...(dtype ? { dtype } : {}),
  };
}

/** On-device inference through transformers-js, in this process. */
export class LocalProvider implements LocalProviderSurface {
  readonly id: string;
  readonly harness = "studio";
  readonly offline = true;
  readonly available = true;
  readonly events = new EventEmitter();
  readonly defaults: Partial<Record<ModelKind, string>>;
  models: LocalModelDefinition[];

  latestProgress: LocalDownloadProgress | null = null;
  loadedModel: LocalLoadedModel | null = null;

  /**
   * Per-file download progress, keyed by modelId → file. A model pulls several
   * files concurrently, so aggregating across them gives a more honest overall
   * percent than `latestProgress`'s single file.
   */
  private readonly _filesByModel = new Map<
    string,
    Map<string, LocalFileProgress>
  >();

  private _preload: Promise<void> | null = null;
  private _preloadState: LocalLoadState = "idle";

  /**
   * Per-modelId caches **shared across all instances**. transformers-js holds
   * tokenizer + processor + ONNX session in each model instance, so a second
   * build of the same id would load another copy of the weights into RAM.
   */
  private static readonly _languageCache = new Map<string, LanguageModelV4>();
  private static readonly _embeddingCache = new Map<string, EmbeddingModelV4>();
  private static readonly _transcriptionCache = new Map<
    string,
    TranscriptionModelV4
  >();
  /** Raw ASR pipelines; segment timings only survive the raw pipeline. */
  private static readonly _asrCache = new Map<string, Promise<AsrPipe>>();

  /** Test-only: the static caches must be empty between cases. */
  static clearCache(): void {
    LocalProvider._languageCache.clear();
    LocalProvider._embeddingCache.clear();
    LocalProvider._transcriptionCache.clear();
    LocalProvider._asrCache.clear();
  }

  constructor(options: LocalProviderOptions = {}) {
    this.id = options.id ?? "local";
    // On-device rows always carry explicit zero costs — see catalog/local.
    this.models = withLocalCosts(options.models ?? LOCAL_DEFAULT_MODELS);
    this.defaults = options.defaults ?? LOCAL_DEFAULTS;
  }

  /**
   * In offline mode, forbid remote weight downloads so an uncached model fails
   * fast instead of hanging on a fetch; cached models still load.
   */
  setOffline(offline: boolean): void {
    env.allowRemoteModels = !offline;
  }

  private cached<T>(map: Map<string, T>, modelId: string, make: () => T): T {
    const existing = map.get(modelId);
    if (existing) {
      return existing;
    }
    const created = make();
    map.set(modelId, created);
    return created;
  }

  private rowFor(modelId: string, kind: ModelKind): LocalModelDefinition {
    return (
      this.models.find((m) => m.modelId === modelId) ?? {
        id: modelId,
        kind,
        modelId,
      }
    );
  }

  languageModel(modelId: string): LanguageModelV4 {
    const def = this.rowFor(modelId, "text");
    return this.cached(LocalProvider._languageCache, def.modelId, () =>
      // Qwen3 emits reasoning inline as `<think>…</think>`; the middleware
      // peels it into `reasoning-*` stream events. No-op for other rows.
      wrapLanguageModel({
        middleware: extractReasoningMiddleware({ tagName: "think" }),
        model: transformersJS.languageModel(
          def.modelId,
          this.bindProgress(def.settings, def)
        ),
      })
    );
  }

  embeddingModel(modelId: string): EmbeddingModelV4 {
    const def = this.rowFor(modelId, "embedding");
    return this.cached(LocalProvider._embeddingCache, def.modelId, () =>
      transformersJS.embeddingModel(
        def.modelId,
        this.bindProgress(def.settings, def)
      )
    );
  }

  transcriptionModel(modelId: string): TranscriptionModelV4 {
    const def = this.rowFor(modelId, "transcription");
    return this.cached(LocalProvider._transcriptionCache, def.modelId, () =>
      transformersJS.transcriptionModel(
        def.modelId,
        this.bindProgress(def.settings, def)
      )
    );
  }

  /**
   * Transcribe with timestamped segments. Runs the raw ASR pipeline, not the
   * AI SDK transcription model, which drops segments.
   */
  async transcribe(
    audio: TranscribeInput,
    opts: TranscribeOptions = {},
    id?: string
  ): Promise<TranscribeResult> {
    const def = this.row(resolveDefinition(this, "transcription", id).id);
    const pipe = await this.loadAsr(def);
    const out = await pipe(toFloat32(audio), {
      language: opts.language,
      return_timestamps: opts.returnTimestamps ?? false,
    });
    return {
      language: opts.language,
      segments: extractSegments(out.chunks),
      text: out.text,
    };
  }

  private loadAsr(def: LocalModelDefinition): Promise<AsrPipe> {
    const cached = LocalProvider._asrCache.get(def.modelId);
    if (cached) {
      return cached;
    }
    const progress = this.bindProgress<{
      rawInitProgressCallback?: (info: ProgressInfo) => void;
    }>({}, def);
    // Boundary cast: the upstream pipeline call type widens to `any`.
    const created = pipeline("automatic-speech-recognition", def.modelId, {
      dtype: def.settings?.dtype ?? "fp32",
      progress_callback: progress.rawInitProgressCallback,
    }) as unknown as Promise<AsrPipe>;
    LocalProvider._asrCache.set(def.modelId, created);
    return created;
  }

  private bindProgress<
    T extends {
      rawInitProgressCallback?: (info: ProgressInfo) => void;
    },
  >(settings: T | undefined, def: LocalModelDefinition): T {
    const userCallback = settings?.rawInitProgressCallback;
    const trace = traceModelDownload(downloadTarget(def));
    return {
      ...(settings ?? ({} as T)),
      rawInitProgressCallback: (info: ProgressInfo) => {
        const event: LocalDownloadProgress = {
          modelId: def.modelId,
          status: info.status,
          ...("file" in info ? { file: info.file } : {}),
          ...("progress" in info ? { progress: info.progress } : {}),
          ...("loaded" in info ? { loaded: info.loaded } : {}),
          ...("total" in info ? { total: info.total } : {}),
        };
        trace.track(event);
        // Terminal (`ready`, `done`, `progress >= 100`) clears the snapshot and
        // marks loaded; `ready` alone is unreliable — transformers-js skips it
        // on partial-cache loads — so `done` and the >=100 fallback are layered
        // in. Lifecycle markers (`initiate`, `download`) are ignored so a tiny
        // file's silent hop cannot clobber the cached percent with "0%".
        const progressVal = event.progress;
        const terminal =
          info.status === "ready" ||
          info.status === "done" ||
          (typeof progressVal === "number" && progressVal >= 100);
        if (terminal) {
          this.latestProgress = null;
          this._filesByModel.delete(def.modelId);
          this.markLoaded(def);
          trace.finish(info.status);
        } else if (typeof progressVal === "number") {
          this.latestProgress = event;
          this.trackFile(def.modelId, event);
        }
        this.events.emit("download-progress", event);
        userCallback?.(info);
      },
    };
  }

  private trackFile(modelId: string, event: LocalDownloadProgress): void {
    if (!event.file) {
      return;
    }
    let files = this._filesByModel.get(modelId);
    if (!files) {
      files = new Map();
      this._filesByModel.set(modelId, files);
    }
    const prev = files.get(event.file);
    const total = event.total ?? prev?.total ?? 0;
    const loaded = event.loaded ?? prev?.loaded ?? 0;
    const progress =
      typeof event.progress === "number"
        ? clamp01(event.progress / 100)
        : total > 0
          ? clamp01(loaded / total)
          : 0;
    files.set(event.file, { file: event.file, loaded, progress, total });
  }

  /** Mean progress (0..1) across a model's in-flight files, or null when idle. */
  aggregateProgress(modelId: string): number | null {
    const files = this._filesByModel.get(modelId);
    if (!files || files.size === 0) {
      return null;
    }
    let sum = 0;
    for (const f of files.values()) {
      sum += f.progress;
    }
    return clamp01(sum / files.size);
  }

  /** Snapshot of the in-flight files for a model (empty when none). */
  downloadFiles(modelId: string): LocalFileProgress[] {
    const files = this._filesByModel.get(modelId);
    return files ? [...files.values()].map((f) => ({ ...f })) : [];
  }

  /** Mean progress (0..1) across every file in flight, or null when idle. */
  overallProgress(): number | null {
    let sum = 0;
    let count = 0;
    for (const files of this._filesByModel.values()) {
      for (const f of files.values()) {
        sum += f.progress;
        count += 1;
      }
    }
    return count > 0 ? clamp01(sum / count) : null;
  }

  /**
   * Warm the default embedding + transcription pipelines so the first real
   * call is fast. Memoized; the first call triggers weight downloads.
   */
  preload(): Promise<void> {
    if (this._preload) {
      return this._preload;
    }
    this._preloadState = "loading";
    this._preload = Promise.allSettled([
      embed({ model: this.embeddingByCatalogId(), value: "" }),
      this.transcribe(new Float32Array(16_000)),
    ]).then((results) => {
      const rejected = results.find((r) => r.status === "rejected");
      this._preloadState = rejected ? "error" : "ready";
      if (rejected?.status === "rejected") {
        throw rejected.reason;
      }
    });
    return this._preload;
  }

  status(): LocalLoadStatus {
    const progress = this.overallProgress();
    if (progress !== null && this._preloadState !== "ready") {
      return { progress, state: "downloading" };
    }
    return {
      progress: this._preloadState === "ready" ? 1 : 0,
      state: this._preloadState,
    };
  }

  private markLoaded(def: LocalModelDefinition): void {
    const dtype = dtypeOf(def);
    const loaded: LocalLoadedModel = {
      kind: def.kind ?? "text",
      label: def.label,
      modelId: def.modelId,
      ...(dtype ? { dtype } : {}),
    };
    this.loadedModel = loaded;
    this.events.emit("model-loaded", loaded);
  }

  /**
   * Fetch + cache one catalog row's weights, by catalog id. Runs the minimal
   * inference that warms the model for its kind, which is what triggers the
   * transformers-js download. Throws on an unknown id.
   */
  async download(id: string): Promise<void> {
    const def = this.row(id);
    const kind = def.kind ?? "text";
    if (kind === "embedding") {
      await embed({ model: this.embeddingModel(def.modelId), value: "" });
    } else if (kind === "transcription") {
      await this.transcribe(new Float32Array(16_000), {}, id);
    } else {
      await generateText({
        maxOutputTokens: 1,
        model: this.languageModel(def.modelId),
        prompt: ".",
      });
    }
  }

  /** In-flight download progress (0..1) by catalog id, or null when idle. */
  progress(id: string): number | null {
    const def = this.models.find((m) => m.id === id);
    return def ? this.aggregateProgress(def.modelId) : null;
  }

  /**
   * True when a row's weights are already in the transformers-js cache.
   * transformers-js exposes no cache query, so this probes the layout directly.
   * Unknown ids and an unset cache dir report not-downloaded rather than throw.
   */
  async isDownloaded(id: string): Promise<boolean> {
    const def = this.models.find((m) => m.id === id);
    const cacheDir = env.cacheDir;
    if (!(def && cacheDir)) {
      return false;
    }
    return modelWeightsPresent(path.join(cacheDir, def.modelId));
  }

  async downloadedModels(): Promise<string[]> {
    const ids: string[] = [];
    for (const def of this.models) {
      if (await this.isDownloaded(def.id)) {
        ids.push(def.id);
      }
    }
    return ids;
  }

  private row(id: string): LocalModelDefinition {
    const def = this.models.find((m) => m.id === id);
    if (!def) {
      throw modelErrors.MODEL_NOT_REGISTERED({ model: id, provider: this.id });
    }
    return def;
  }

  private embeddingByCatalogId(id?: string): EmbeddingModelV4 {
    return this.embeddingModel(
      resolveDefinition(this, "embedding", id).modelId
    );
  }
}

/**
 * A model dir counts as downloaded when its `config.json` exists and at least
 * one non-empty `.onnx` weight file is present. dtype variants make the exact
 * weight filename unpredictable, so presence of any non-empty weight is the
 * signal. Shared with the worker-backed provider, which probes the same dir.
 */
export async function modelWeightsPresent(dir: string): Promise<boolean> {
  try {
    await access(path.join(dir, "config.json"));
  } catch {
    return false;
  }
  return hasNonEmptyOnnx(dir);
}

async function hasNonEmptyOnnx(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await hasNonEmptyOnnx(full)) {
        return true;
      }
    } else if (entry.name.endsWith(".onnx")) {
      try {
        if ((await stat(full)).size > 0) {
          return true;
        }
      } catch {
        // Unreadable file — keep scanning; another weight may qualify.
      }
    }
  }
  return false;
}

function dtypeOf(def: LocalModelDefinition): string | undefined {
  const dtype = (def.settings as { dtype?: unknown } | undefined)?.dtype;
  return typeof dtype === "string" ? dtype : undefined;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) {
    return 0;
  }
  if (n < 0) {
    return 0;
  }
  if (n > 1) {
    return 1;
  }
  return n;
}

/** Normalize accepted audio inputs to the `Float32Array` the ASR pipeline wants. */
export function toFloat32(input: TranscribeInput): Float32Array {
  if (input instanceof Float32Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Float32Array(input);
  }
  if (Buffer.isBuffer(input)) {
    return new Float32Array(
      input.buffer,
      input.byteOffset,
      input.byteLength / Float32Array.BYTES_PER_ELEMENT
    );
  }
  throw new Error("[local] unsupported audio input for transcription");
}

function extractSegments(chunks: unknown): TranscribeSegment[] | undefined {
  if (!Array.isArray(chunks)) {
    return undefined;
  }
  return chunks
    .map((c) => {
      const obj = c as {
        timestamp?: [number | null, number | null];
        text?: string;
      };
      const [start, end] = obj.timestamp ?? [null, null];
      if (start == null || end == null || !obj.text) {
        return null;
      }
      return { end, start, text: obj.text };
    })
    .filter((x): x is TranscribeSegment => x !== null);
}
