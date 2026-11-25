export const MODEL_KINDS = [
  "text",
  "embedding",
  "transcription",
  "image",
  "video",
  "speech",
  "music",
  "sound",
  "segmentation",
] as const;

export type ModelKind = (typeof MODEL_KINDS)[number];

export type OperationName =
  | "generate-text"
  | "reformat-text"
  | "generate-image"
  | "generate-video"
  | "generate-speech"
  | "generate-music"
  | "generate-sound-effect"
  | "transcribe"
  | "segment-image"
  | "segment-video";

export type InteractionMode = "request" | "live";

export type InputForm =
  | "direction"
  | "reference-media"
  | "source-text"
  | "source-audio"
  | "source-video"
  | "source-image"
  | "frame"
  | "feed"
  | "segmentation-prompt";

export type DeliveryForm =
  | "whole"
  | "incremental"
  | "result-per-input"
  | "continuous";

export interface CapabilityFact {
  readonly delivery: DeliveryForm;
  readonly inputs: readonly InputForm[];
  readonly mode: InteractionMode;
  readonly operation: OperationName;
  readonly outputs: readonly string[];
  readonly required: readonly InputForm[];
}

export interface MediaPrice {
  readonly unit: "image" | "second" | "megapixel" | "character" | "request";
  readonly usd: number;
}

export interface ModelCostTier {
  costPer1M: number;
  maxTokens?: number;
  minTokens: number;
}

export interface ModelCosts {
  cachedInput?: number;
  cacheWrite?: number;
  input: number;
  inputTiers?: ModelCostTier[];
  output: number;
  outputTiers?: ModelCostTier[];
}

export interface ModelLimits {
  maxDurationSeconds?: number;
  maxInputBytes?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxResolution?: { width: number; height: number };
}

export interface ModelCapabilities {
  fileInput?: boolean;
  functionCalling?: boolean;
  reasoning?: boolean;
  vision?: boolean;
  webSearch?: boolean;
}

export interface ProviderModelDefinition {
  capabilities?: ModelCapabilities;
  costs?: ModelCosts;
  description?: string;
  dimensions?: number;
  id: string;
  kind: ModelKind;
  label?: string;
  limits?: ModelLimits;
  modelId: string;
  operations?: readonly CapabilityFact[];
  params?: string[];
  price?: MediaPrice;
  vendor?: string;
}

export interface Media {
  readonly bytes: Uint8Array;
  readonly mime: string;
}

export type SegmentationPrompt =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "points";
      readonly points: readonly { x: number; y: number; label: 0 | 1 }[];
    }
  | {
      readonly kind: "box";
      readonly box: { x: number; y: number; width: number; height: number };
    };

export type MediaInput =
  | {
      readonly operation: "segment-image";
      readonly image: Media;
      readonly prompt: SegmentationPrompt;
    }
  | {
      readonly operation: "segment-video";
      readonly video: Media;
      readonly prompt: SegmentationPrompt;
    }
  | {
      readonly operation: "generate-music";
      readonly direction: string;
      readonly durationSeconds?: number;
    }
  | {
      readonly operation: "generate-sound-effect";
      readonly direction: string;
      readonly durationSeconds?: number;
    };

export interface Mask {
  readonly box?: { x: number; y: number; width: number; height: number };
  readonly id: string;
  readonly image: Media;
  readonly label?: string;
  readonly score?: number;
}

export interface Track {
  readonly frames: readonly { readonly index: number; readonly mask: Media }[];
  readonly id: string;
  readonly label?: string;
}

export type MediaOutput =
  | { readonly operation: "segment-image"; readonly masks: readonly Mask[] }
  | {
      readonly operation: "segment-video";
      readonly tracks: readonly Track[];
      readonly preview?: Media;
    }
  | {
      readonly operation: "generate-music" | "generate-sound-effect";
      readonly audio: Media;
    };

export interface MediaModel {
  run(
    input: MediaInput,
    options?: { signal?: AbortSignal }
  ): Promise<MediaOutput>;
}

export interface TranscribeSegment {
  end: number;
  start: number;
  text: string;
}

export interface TranscribeResult {
  language?: string;
  segments?: TranscribeSegment[];
  text: string;
}

export interface TranscribeOptions {
  language?: string;
  returnTimestamps?: boolean;
}

export type TranscribeInput = Float32Array | ArrayBuffer | Uint8Array;
