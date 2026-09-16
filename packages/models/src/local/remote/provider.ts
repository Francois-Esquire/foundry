import { EventEmitter } from "node:events";
import path from "node:path";
import type {
  EmbeddingModelV4,
  EmbeddingModelV4CallOptions,
  EmbeddingModelV4Result,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";

import { env } from "@huggingface/transformers";
import { withLocalCosts } from "../../catalog/local";
import { resolveDefinition } from "../../provider";
import type {
  ModelKind,
  TranscribeInput,
  TranscribeOptions,
  TranscribeResult,
} from "../../types";
import {
  LOCAL_DEFAULT_MODELS,
  LOCAL_DEFAULTS,
  modelWeightsPresent,
  toFloat32,
} from "../provider";
import type {
  LocalLoadStatus,
  LocalModelDefinition,
  LocalProviderSurface,
} from "../surface";
import type { HostTransport, WorkerRequest } from "./protocol";
import { encodeAudio } from "./protocol";

export interface RemoteLocalProviderOptions {
  defaults?: Partial<Record<ModelKind, string>>;
  id?: string;
  models?: LocalModelDefinition[];
  transport: HostTransport;
}

interface Pending {
  onEnd?: () => void;
  onPart?: (part: unknown) => void;
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
}

/**
 * The local provider's surface with worker backing: every inference call
 * crosses the injected {@link HostTransport} to a real {@link LocalProvider}
 * in an unbound Node process (see worker.ts). Exists because Electron's main
 * process caps JS-side buffer memory far below what ~GB weights need.
 *
 * Sync status surfaces (`status`, `progress`) answer from a cache refreshed by
 * a background round-trip per call — one poll tick stale, which the polling UI
 * absorbs. The downloaded-probe reads the shared disk directly.
 */
export class RemoteLocalProvider implements LocalProviderSurface {
  readonly id: string;
  readonly harness = "studio";
  readonly offline = true;
  readonly available = true;
  readonly events = new EventEmitter();
  readonly defaults: Partial<Record<ModelKind, string>>;
  models: LocalModelDefinition[];

  private readonly transport: HostTransport;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private exitReason: string | null = null;

  private statusCache: LocalLoadStatus = { progress: 0, state: "idle" };
  private readonly progressCache = new Map<string, number | null>();

  constructor(options: RemoteLocalProviderOptions) {
    this.id = options.id ?? "local";
    this.models = withLocalCosts(options.models ?? LOCAL_DEFAULT_MODELS);
    this.defaults = options.defaults ?? LOCAL_DEFAULTS;
    this.transport = options.transport;

    this.transport.onMessage((msg) => {
      if (msg.id === 0 && msg.type === "event") {
        this.events.emit(msg.name, msg.payload);
        return;
      }
      const entry = this.pending.get(msg.id);
      if (!entry) {
        return;
      }
      if (msg.type === "result") {
        this.pending.delete(msg.id);
        entry.resolve(msg.value);
      } else if (msg.type === "stream-part") {
        entry.onPart?.(msg.part);
      } else if (msg.type === "stream-end") {
        this.pending.delete(msg.id);
        entry.onEnd?.();
      } else if (msg.type === "error") {
        this.pending.delete(msg.id);
        entry.reject(remoteError(msg.message, msg.name));
      }
    });

    this.transport.onExit((reason) => {
      this.exitReason = reason;
      const dead = [...this.pending.values()];
      this.pending.clear();
      for (const entry of dead) {
        entry.reject(remoteError(`local worker exited: ${reason}`));
      }
    });
  }

  /** True once the worker is gone; the host adapter swaps in a fresh one. */
  get workerLost(): boolean {
    return this.exitReason !== null;
  }

  private post(request: WorkerRequest): void {
    if (this.exitReason !== null) {
      throw remoteError(`local worker exited: ${this.exitReason}`);
    }
    this.transport.send(request);
  }

  private request(
    make: (id: number) => WorkerRequest,
    hooks: Omit<Pending, "resolve" | "reject"> = {},
    abortSignal?: AbortSignal
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve, ...hooks });
      abortSignal?.addEventListener(
        "abort",
        () => {
          if (!this.pending.has(id) || this.exitReason !== null) {
            return;
          }
          this.post({ id: this.nextId++, op: "cancel", target: id });
        },
        { once: true }
      );
      try {
        this.post(make(id));
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  languageModel(modelId: string): LanguageModelV4 {
    return {
      doGenerate: async (options: LanguageModelV4CallOptions) => {
        const { abortSignal, headers: _headers, ...wire } = options;
        // Boundary cast: the wire carries the worker model's real result.
        return (await this.request(
          (rid) => ({ id: rid, model: modelId, op: "generate", options: wire }),
          {},
          abortSignal
        )) as LanguageModelV4GenerateResult;
      },
      doStream: (options: LanguageModelV4CallOptions) => {
        const { abortSignal, headers: _headers, ...wire } = options;
        const stream = new ReadableStream<LanguageModelV4StreamPart>({
          start: (controller) => {
            this.request(
              (rid) => ({
                id: rid,
                model: modelId,
                op: "stream",
                options: wire,
              }),
              {
                onEnd: () => {
                  controller.close();
                },
                onPart: (part) => {
                  controller.enqueue(part as LanguageModelV4StreamPart);
                },
              },
              abortSignal
            ).catch((error: unknown) => {
              controller.error(error);
            });
          },
        });
        return Promise.resolve({ stream });
      },
      modelId,
      provider: this.id,
      specificationVersion: "v4",
      supportedUrls: {},
    };
  }

  embeddingModel(modelId: string): EmbeddingModelV4 {
    return {
      doEmbed: async (options: EmbeddingModelV4CallOptions) => {
        const { abortSignal, headers: _headers, ...wire } = options;
        // Boundary cast: the wire carries the worker model's real result.
        return (await this.request(
          (rid) => ({ id: rid, model: modelId, op: "embed", options: wire }),
          {},
          abortSignal
        )) as EmbeddingModelV4Result;
      },
      maxEmbeddingsPerCall: undefined,
      modelId,
      provider: this.id,
      specificationVersion: "v4",
      supportsParallelCalls: false,
    };
  }

  async transcribe(
    audio: TranscribeInput,
    opts: TranscribeOptions = {},
    id?: string
  ): Promise<TranscribeResult> {
    const def = resolveDefinition(this, "transcription", id);
    const value = await this.request((rid) => ({
      audio: encodeAudio(toFloat32(audio)),
      id: rid,
      model: def.id,
      op: "transcribe",
      options: opts,
    }));
    return value as TranscribeResult;
  }

  async download(id: string): Promise<void> {
    await this.request((rid) => ({ id: rid, model: id, op: "download" }));
  }

  preload(): Promise<void> {
    return this.request((rid) => ({ id: rid, op: "preload" })).then(() => {
      this.refreshStatus();
    });
  }

  status(): LocalLoadStatus {
    this.refreshStatus();
    return this.statusCache;
  }

  progress(id: string): number | null {
    void this.request((rid) => ({ id: rid, model: id, op: "progress" }))
      .then((value) => this.progressCache.set(id, value as number | null))
      .catch(() => undefined);
    return this.progressCache.get(id) ?? null;
  }

  /** Same on-disk probe as the in-process provider — the cache dir is shared. */
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

  /**
   * The worker holds its own `@huggingface/transformers` env, so Airplane Mode
   * has to cross the process boundary or the child keeps allowing remote
   * fetches. Fire-and-forget; a lost worker surfaces on the next request.
   */
  setOffline(offline: boolean): void {
    void this.request((rid) => ({ id: rid, offline, op: "set-offline" })).catch(
      () => undefined
    );
  }

  private refreshStatus(): void {
    void this.request((rid) => ({ id: rid, op: "status" }))
      .then((value) => {
        this.statusCache = value as LocalLoadStatus;
      })
      .catch(() => undefined);
  }
}

function remoteError(message: string, name?: string): Error {
  const error = new Error(message);
  if (name) {
    error.name = name;
  }
  return error;
}
