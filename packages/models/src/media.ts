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
