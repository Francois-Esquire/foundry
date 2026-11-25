import type { EventEmitter } from "node:events";
import type {
  TransformersJSEmbeddingSettings,
  TransformersJSModelSettings,
  TransformersJSTranscriptionSettings,
} from "@browser-ai/transformers-js";
import type { ProgressInfo } from "@huggingface/transformers";
import type {
  TranscribeInput,
  TranscribeOptions,
  TranscribeResult,
} from "../../media";
import type {
  ModelKind,
  ProviderModelDefinition,
} from "../../model-definition";
import type { Provider } from "../../provider";

export interface LocalLoadedModel {
  dtype?: string;
  kind: ModelKind;
  label?: string;
  modelId: string;
}

export interface LocalDownloadProgress {
  file?: string;
  loaded?: number;
  modelId: string;
  progress?: number;
  status: ProgressInfo["status"];
  total?: number;
}

export interface LocalFileProgress {
  file: string;
  loaded: number;
  progress: number;
  total: number;
}

export type LocalLoadState =
  | "idle"
  | "loading"
  | "downloading"
  | "ready"
  | "error";

export interface LocalLoadStatus {
  progress: number;
  state: LocalLoadState;
}

export interface LocalModelDefinition extends ProviderModelDefinition {
  settings?:
    | TransformersJSModelSettings
    | TransformersJSEmbeddingSettings
    | TransformersJSTranscriptionSettings;
}

export interface LocalProviderSurface extends Provider {
  download(id: string): Promise<void>;
  downloadedModels(): Promise<string[]>;
  readonly events: EventEmitter;
  isDownloaded(id: string): Promise<boolean>;
  models: LocalModelDefinition[];
  preload(): Promise<void>;
  progress(id: string): number | null;
  status(): LocalLoadStatus;
  transcribe(
    audio: TranscribeInput,
    opts?: TranscribeOptions,
    id?: string
  ): Promise<TranscribeResult>;
}

const LOCAL_METHODS = [
  "status",
  "preload",
  "download",
  "progress",
  "isDownloaded",
  "downloadedModels",
  "transcribe",
] as const;

export function isLocalProvider(
  provider: Provider
): provider is LocalProviderSurface {
  const candidate = provider as Partial<LocalProviderSurface>;
  return LOCAL_METHODS.every((name) => typeof candidate[name] === "function");
}
