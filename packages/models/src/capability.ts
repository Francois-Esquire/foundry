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
