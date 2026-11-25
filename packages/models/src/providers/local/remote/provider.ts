import { EventEmitter } from "node:events";
import type {
  EmbeddingModelV4,
  EmbeddingModelV4CallOptions,
  EmbeddingModelV4Result,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { modelErrors } from "../../../errors";
import type {
  TranscribeInput,
  TranscribeOptions,
  TranscribeResult,
} from "../../../media";
import { catalogRow } from "../../../provider";
import type { LocalProviderOptions } from "../../local";
import { OnDeviceProvider, toFloat32 } from "../../local";
import type { LocalLoadStatus, LocalProviderSurface } from "../surface";
import type { HostTransport, WorkerRequest } from "./protocol";
import { encodeAudio } from "./protocol";

export interface RemoteLocalProviderOptions extends LocalProviderOptions {
  offlineTimeoutMs?: number;
  transport: HostTransport;
}

const OFFLINE_TIMEOUT_MS = 5000;

interface Pending {
  onEnd?: () => void;
  onPart?: (part: unknown) => void;
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
}

export class RemoteLocalProvider
  extends OnDeviceProvider
  implements LocalProviderSurface
{
  readonly events = new EventEmitter();

  private readonly transport: HostTransport;
  private readonly offlineTimeoutMs: number;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private exitReason: string | null = null;

  private statusCache: LocalLoadStatus = { progress: 0, state: "idle" };
  private readonly progressCache = new Map<string, number | null>();

  constructor(options: RemoteLocalProviderOptions) {
    super(options);
    this.transport = options.transport;
    this.offlineTimeoutMs = options.offlineTimeoutMs ?? OFFLINE_TIMEOUT_MS;

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
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve, ...hooks });
      abortSignal?.addEventListener(
        "abort",
        () => {
          if (!this.pending.has(id) || this.exitReason !== null) {
            return;
          }
          const cancelId = this.nextId;
          this.nextId += 1;
          this.post({ id: cancelId, op: "cancel", target: id });
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
    const def = catalogRow(this, "transcription", id);
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
    this.request((rid) => ({ id: rid, model: id, op: "progress" }))
      .then((value) => this.progressCache.set(id, value as number | null))
      .catch(() => undefined);
    return this.progressCache.get(id) ?? null;
  }

  async setOffline(offline: boolean): Promise<void> {
    const applied = this.request((rid) => ({
      id: rid,
      offline,
      op: "set-offline",
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no answer within ${this.offlineTimeoutMs}ms`)),
        this.offlineTimeoutMs
      );
    });
    try {
      await Promise.race([applied, late]);
    } catch (error) {
      applied.catch(() => undefined);
      if (!offline) {
        throw error;
      }
      let workerState = "worker already exited";
      if (!this.workerLost) {
        workerState = this.transport.terminate
          ? "worker stopped"
          : "worker left running";
        this.transport.terminate?.();
      }
      throw modelErrors.PROVIDER_OFFLINE_UNCONFIRMED({
        provider: this.id,
        reason: `${error instanceof Error ? error.message : String(error)}; ${workerState}`,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private refreshStatus(): void {
    this.request((rid) => ({ id: rid, op: "status" }))
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
