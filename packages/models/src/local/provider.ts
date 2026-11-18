import { EventEmitter } from "node:events";
import type { Dirent } from "node:fs";
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
import { LOCAL_EMBEDDING_MODEL_ID, withLocalCosts } from "../catalog/local";
import { modelErrors } from "../errors";
import type { ModelDownloadTarget } from "../logger";
import { traceModelDownload } from "../logger";
import { catalogRow } from "../provider";
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

export type {
  LocalDownloadProgress,
  LocalFileProgress,
  LocalLoadedModel,
  LocalLoadState,
  LocalLoadStatus,
  LocalModelDefinition,
  LocalProviderSurface,
} from "./surface";
// biome-ignore lint/performance/noBarrelFile: The /local subpath carries the on-device surface off the base entry.
export { isLocalProvider } from "./surface";

let configured = false;
const offlineInstances = new Set<LocalProvider>();

const remoteFetches = new Set<AbortController>();
const fetchRemote = env.fetch;

function isRemote(input: Parameters<typeof env.fetch>[0]): boolean {
  const url = String(input);
  return url.startsWith("http:") || url.startsWith("https:");
}

async function guardedFetch(
  input: Parameters<typeof env.fetch>[0],
  init?: RequestInit
): Promise<Response> {
  if (!isRemote(input)) {
    return fetchRemote(input, init);
  }
  if (offlineInstances.size > 0) {
    throw new Error(`offline: refused to fetch ${String(input)}`);
  }
  const controller = new AbortController();
  remoteFetches.add(controller);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;
  try {
    const response = await fetchRemote(input, { ...init, signal });
    if (!response.body) {
      remoteFetches.delete(controller);
      return response;
    }
    return new Response(
      settled(response.body, () => remoteFetches.delete(controller)),
      response
    );
  } catch (error) {
    remoteFetches.delete(controller);
    throw error;
  }
}

function settled(
  body: ReadableStream<Uint8Array>,
  done: () => void
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    cancel: async (reason) => {
      done();
      await reader.cancel(reason);
    },
    pull: async (controller) => {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          done();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        done();
        controller.error(error);
      }
    },
  });
}

env.fetch = guardedFetch;

function allowRemoteLoads(): void {
  env.allowRemoteModels = offlineInstances.size === 0;
  if (offlineInstances.size > 0) {
    for (const fetching of remoteFetches) {
      fetching.abort(new Error("offline"));
    }
    remoteFetches.clear();
  }
}

export function configureCache(cacheDir: string): void {
  if (configured) {
    return;
  }
  env.cacheDir = cacheDir;
  env.allowLocalModels = true;
  allowRemoteLoads();
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
    modelId: LOCAL_EMBEDDING_MODEL_ID,
  },
  {
    id: "transcribe",
    kind: "transcription",
    label: "Whisper Base (English)",
    modelId: "Xenova/whisper-base.en",
  },
];

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

function downloadTarget(def: LocalModelDefinition): ModelDownloadTarget {
  const dtype = dtypeOf(def);
  return {
    modelId: def.modelId,
    ...(def.label ? { label: def.label } : {}),
    kind: def.kind,
    ...(dtype ? { dtype } : {}),
  };
}

export abstract class OnDeviceProvider {
  readonly available = true;
  readonly defaults: Partial<Record<ModelKind, string>>;
  readonly id: string;
  models: LocalModelDefinition[];
  readonly offline = true;

  constructor(options: LocalProviderOptions = {}) {
    this.id = options.id ?? "local";
    this.models = withLocalCosts(options.models ?? LOCAL_DEFAULT_MODELS);
    this.defaults = options.defaults ?? LOCAL_DEFAULTS;
  }

  async isDownloaded(id: string): Promise<boolean> {
    const def = this.models.find((m) => m.id === id);
    const { cacheDir } = env;
    if (!(def && cacheDir)) {
      return false;
    }
    return await modelWeightsPresent(path.join(cacheDir, def.modelId));
  }

  async downloadedModels(): Promise<string[]> {
    const present = await Promise.all(
      this.models.map((def) => this.isDownloaded(def.id))
    );
    return this.models
      .filter((_, index) => present[index])
      .map((def) => def.id);
  }
}

interface DownloadState {
  readonly events: EventEmitter;
  readonly files: Map<string, Map<string, LocalFileProgress>>;
  latest: LocalDownloadProgress | null;
  loaded: LocalLoadedModel | null;
}

export class LocalProvider
  extends OnDeviceProvider
  implements LocalProviderSurface
{
  private static readonly downloads: DownloadState = {
    events: new EventEmitter(),
    files: new Map(),
    latest: null,
    loaded: null,
  };

  readonly events = LocalProvider.downloads.events;

  get latestProgress(): LocalDownloadProgress | null {
    return LocalProvider.downloads.latest;
  }

  get loadedModel(): LocalLoadedModel | null {
    return LocalProvider.downloads.loaded;
  }

  private _preload: Promise<void> | null = null;
  private _preloadState: LocalLoadState = "idle";

  private static readonly _languageCache = new Map<string, LanguageModelV4>();
  private static readonly _embeddingCache = new Map<string, EmbeddingModelV4>();
  private static readonly _transcriptionCache = new Map<
    string,
    TranscriptionModelV4
  >();
  private static readonly _asrCache = new Map<string, Promise<AsrPipe>>();

  static clearCache(): void {
    offlineInstances.clear();
    remoteFetches.clear();
    LocalProvider._languageCache.clear();
    LocalProvider._embeddingCache.clear();
    LocalProvider._transcriptionCache.clear();
    LocalProvider._asrCache.clear();
    const { downloads } = LocalProvider;
    downloads.events.removeAllListeners();
    downloads.files.clear();
    downloads.latest = null;
    downloads.loaded = null;
  }

  setOffline(enabled: boolean): void {
    if (enabled) {
      offlineInstances.add(this);
    } else {
      offlineInstances.delete(this);
    }
    allowRemoteLoads();
  }

  dispose(): Promise<void> {
    offlineInstances.delete(this);
    allowRemoteLoads();
    return Promise.resolve();
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

  async transcribe(
    audio: TranscribeInput,
    opts: TranscribeOptions = {},
    id?: string
  ): Promise<TranscribeResult> {
    const def = this.row(catalogRow(this, "transcription", id).id);
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
        const progressVal = event.progress;
        const terminal =
          info.status === "ready" ||
          info.status === "done" ||
          (typeof progressVal === "number" && progressVal >= 100);
        if (terminal) {
          LocalProvider.downloads.latest = null;
          LocalProvider.downloads.files.delete(def.modelId);
          this.markLoaded(def);
          trace.finish(info.status);
        } else if (typeof progressVal === "number") {
          LocalProvider.downloads.latest = event;
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
    const { downloads } = LocalProvider;
    let files = downloads.files.get(modelId);
    if (!files) {
      files = new Map();
      downloads.files.set(modelId, files);
    }
    const prev = files.get(event.file);
    const total = event.total ?? prev?.total ?? 0;
    const loaded = event.loaded ?? prev?.loaded ?? 0;
    let progress = 0;
    if (typeof event.progress === "number") {
      progress = clamp01(event.progress / 100);
    } else if (total > 0) {
      progress = clamp01(loaded / total);
    }
    files.set(event.file, { file: event.file, loaded, progress, total });
  }

  aggregateProgress(modelId: string): number | null {
    const files = LocalProvider.downloads.files.get(modelId);
    if (!files || files.size === 0) {
      return null;
    }
    let sum = 0;
    for (const f of files.values()) {
      sum += f.progress;
    }
    return clamp01(sum / files.size);
  }

  downloadFiles(modelId: string): LocalFileProgress[] {
    const files = LocalProvider.downloads.files.get(modelId);
    return files ? [...files.values()].map((f) => ({ ...f })) : [];
  }

  overallProgress(): number | null {
    let sum = 0;
    let count = 0;
    for (const files of LocalProvider.downloads.files.values()) {
      for (const f of files.values()) {
        sum += f.progress;
        count += 1;
      }
    }
    return count > 0 ? clamp01(sum / count) : null;
  }

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
      kind: def.kind,
      label: def.label,
      modelId: def.modelId,
      ...(dtype ? { dtype } : {}),
    };
    LocalProvider.downloads.loaded = loaded;
    this.events.emit("model-loaded", loaded);
  }

  async download(id: string): Promise<void> {
    const def = this.row(id);
    const { kind } = def;
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

  progress(id: string): number | null {
    const def = this.models.find((m) => m.id === id);
    return def ? this.aggregateProgress(def.modelId) : null;
  }

  private row(id: string): LocalModelDefinition {
    const def = this.models.find((m) => m.id === id);
    if (!def) {
      throw modelErrors.MODEL_NOT_FOUND({ model: id, searched: [this.id] });
    }
    return def;
  }

  private embeddingByCatalogId(id?: string): EmbeddingModelV4 {
    return this.embeddingModel(catalogRow(this, "embedding", id).modelId);
  }
}

export async function modelWeightsPresent(dir: string): Promise<boolean> {
  try {
    await access(path.join(dir, "config.json"));
  } catch {
    return false;
  }
  return hasNonEmptyOnnx(dir);
}

async function hasNonEmptyOnnx(dir: string): Promise<boolean> {
  let entries: Dirent[];
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
      if (
        start === null ||
        start === undefined ||
        end === null ||
        end === undefined ||
        !obj.text
      ) {
        return null;
      }
      return { end, start, text: obj.text };
    })
    .filter((x): x is TranscribeSegment => x !== null);
}
