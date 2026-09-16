import type { Provider } from "./provider";

export type ModelKind =
  | "text"
  | "embedding"
  | "transcription"
  | "image"
  | "video"
  | "speech"
  | "music"
  | "sound"
  | "segmentation";

/** One thing a caller can ask a Model to do. Names are persisted by hosts. */
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

/**
 * `whole`/`incremental` are Request mode; `result-per-input`/`continuous` are
 * Live mode and tell a caller which transport the session uses.
 */
export type DeliveryForm =
  | "whole"
  | "incremental"
  | "result-per-input"
  | "continuous";

/**
 * What a Model can do, for one Operation in one mode. Absence of a fact means
 * not offered: selection reads facts, never Kind.
 */
export interface CapabilityFact {
  readonly delivery: DeliveryForm;
  readonly inputs: readonly InputForm[];
  readonly mode: InteractionMode;
  readonly operation: OperationName;
  /** MIME types the Model can return; the first is what a caller gets. */
  readonly outputs: readonly string[];
  /** Subset of {@link inputs} that must be present. */
  readonly required: readonly InputForm[];
}

/** Catalog list price per unit. Never fed to the token cost map. */
export interface MediaPrice {
  readonly unit: "image" | "second" | "megapixel" | "character" | "request";
  readonly usd: number;
}

export interface KindDefault {
  modelId?: string;
  provider: string;
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

/** Known bounds. An absent field is Unknown, not unlimited. */
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

/**
 * One catalog row. `id` is how callers and the picker name the model; `modelId`
 * is what goes on the wire. They coincide for cloud providers and differ for
 * on-device rows, whose short ids (`text`, `embed`) are persisted by hosts.
 */
export interface ProviderModelDefinition {
  capabilities?: ModelCapabilities;
  costs?: ModelCosts;
  description?: string;
  /** Output vector size for embedding models. Drives default chunk sizing. */
  dimensions?: number;
  id: string;
  kind?: ModelKind;
  label?: string;
  limits?: ModelLimits;
  modelId: string;
  /** Declared Capability facts. When present they win over {@link kind}. */
  operations?: readonly CapabilityFact[];
  params?: string[];
  /** Media list price. Absent is Unknown. */
  price?: MediaPrice;
  vendor?: string;
}

/** Bytes plus their MIME. Providers upload them; callers never host a URL. */
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

/** A PNG alpha mask, reusable as Reference media. */
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

/**
 * The Models-owned seam for Operations the AI SDK has no model kind for. The
 * Provider translates vendor JSON; callers never see it.
 */
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

export type TranscribeInput = Float32Array | ArrayBuffer | Buffer;

/** One Model admitted for one Operation. The ids are what a caller persists. */
export interface Selection {
  readonly fact: CapabilityFact;
  readonly model: ProviderModelDefinition;
  readonly provider: Provider;
}

/** One row a Provider offers for an Operation, with its Availability. */
export interface Offer {
  readonly available: boolean;
  readonly fact: CapabilityFact;
  readonly model: ProviderModelDefinition;
  readonly provider: string;
}
