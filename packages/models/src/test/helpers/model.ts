import type {
  EmbeddingModelV4,
  Experimental_VideoModelV4,
  ImageModelV4,
  LanguageModelV4,
  SpeechModelV4,
  TranscriptionModelV4,
} from "@ai-sdk/provider";

import type { Provider } from "../../provider";
import type {
  Media,
  MediaOutput,
  ModelKind,
  ProviderModelDefinition,
} from "../../types";

export interface FakeProviderOptions {
  available?: boolean;
  defaults?: Partial<Record<ModelKind, string>>;
  discover?: () => Promise<ProviderModelDefinition[]>;
  harness?: string;
  /**
   * Which optional accessors the provider declares. `video`, `media`, and
   * `grant` are opt-in so existing callers keep the defaults they had.
   */
  kinds?: (
    | "embedding"
    | "image"
    | "speech"
    | "transcription"
    | "video"
    | "media"
    | "grant"
  )[];
  models?: ProviderModelDefinition[];
  offline?: boolean;
}

export interface FakeProvider extends Provider {
  available: boolean;
  calls: string[];
  disposed: number;
  offlineCalls: boolean[];
}

const DEFAULT_MODELS: ProviderModelDefinition[] = [
  { id: "smart", kind: "text", modelId: "upstream/smart" },
  { id: "embed", kind: "embedding", modelId: "upstream/embed" },
];

/** A recording provider: every model build lands in `calls` as `kind:wireId`. */
export function fakeProvider(
  id: string,
  options: FakeProviderOptions = {}
): FakeProvider {
  const kinds = new Set(
    options.kinds ?? ["embedding", "image", "speech", "transcription"]
  );
  const stub = (kind: string, modelId: string) =>
    ({ kind, modelId, provider: id }) as never;
  const provider: FakeProvider = {
    available: options.available ?? true,
    calls: [],
    defaults: options.defaults ?? { embedding: "embed", text: "smart" },
    dispose: () => {
      provider.disposed += 1;
      return Promise.resolve();
    },
    disposed: 0,
    harness: options.harness ?? "studio",
    id,
    languageModel: (modelId): LanguageModelV4 => {
      provider.calls.push(`text:${modelId}`);
      return stub("text", modelId);
    },
    models: options.models ?? DEFAULT_MODELS,
    offline: options.offline ?? false,
    offlineCalls: [],
    setOffline: (offline) => {
      provider.offlineCalls.push(offline);
    },
    ...(options.discover ? { discover: options.discover } : {}),
  };
  if (kinds.has("embedding")) {
    provider.embeddingModel = (modelId): EmbeddingModelV4 => {
      provider.calls.push(`embedding:${modelId}`);
      return stub("embedding", modelId);
    };
  }
  if (kinds.has("image")) {
    provider.imageModel = (modelId): ImageModelV4 => {
      provider.calls.push(`image:${modelId}`);
      return stub("image", modelId);
    };
  }
  if (kinds.has("speech")) {
    provider.speechModel = (modelId): SpeechModelV4 => {
      provider.calls.push(`speech:${modelId}`);
      return stub("speech", modelId);
    };
  }
  if (kinds.has("transcription")) {
    provider.transcriptionModel = (modelId): TranscriptionModelV4 => {
      provider.calls.push(`transcription:${modelId}`);
      return stub("transcription", modelId);
    };
  }
  if (kinds.has("video")) {
    provider.videoModel = (modelId): Experimental_VideoModelV4 => {
      provider.calls.push(`video:${modelId}`);
      return stub("video", modelId);
    };
  }
  if (kinds.has("media")) {
    provider.mediaModel = (modelId) => ({
      run: (input) => {
        provider.calls.push(`media:${modelId}:${input.operation}`);
        return Promise.resolve(mediaOutputFor(input.operation));
      },
    });
  }
  if (kinds.has("grant")) {
    provider.grant = (modelId, operation) => {
      provider.calls.push(`grant:${modelId}:${operation}`);
      return Promise.resolve({
        expiresAt: Date.now() + 60_000,
        kind: "token" as const,
        token: "fake",
      });
    };
  }
  return provider;
}

const FAKE_MEDIA: Media = {
  bytes: new Uint8Array([1, 2, 3]),
  mime: "image/png",
};

function mediaOutputFor(operation: MediaOutput["operation"]): MediaOutput {
  switch (operation) {
    case "segment-image":
      return {
        masks: [{ id: "m1", image: FAKE_MEDIA }],
        operation,
      };
    case "segment-video":
      return {
        operation,
        tracks: [{ frames: [{ index: 0, mask: FAKE_MEDIA }], id: "t1" }],
      };
    case "generate-music":
    case "generate-sound-effect":
      return {
        audio: { bytes: new Uint8Array([4]), mime: "audio/mpeg" },
        operation,
      };
  }
}
