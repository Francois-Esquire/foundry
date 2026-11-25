import type {
  EmbeddingModelV4CallOptions,
  LanguageModelV4CallOptions,
} from "@ai-sdk/provider";

import type { TranscribeOptions } from "../../../media";

type WireCallOptions = Omit<
  LanguageModelV4CallOptions,
  "abortSignal" | "headers"
>;

type WireEmbedOptions = Omit<
  EmbeddingModelV4CallOptions,
  "abortSignal" | "headers"
>;

export type WorkerRequest =
  | { id: number; op: "generate"; model: string; options: WireCallOptions }
  | { id: number; op: "stream"; model: string; options: WireCallOptions }
  | { id: number; op: "embed"; model: string; options: WireEmbedOptions }
  | {
      id: number;
      op: "transcribe";
      model?: string;
      audio: string;
      options: TranscribeOptions;
    }
  | { id: number; op: "download"; model: string }
  | { id: number; op: "preload" }
  | { id: number; op: "status" }
  | { id: number; op: "progress"; model: string }
  | { id: number; op: "set-offline"; offline: boolean }
  | { id: number; op: "cancel"; target: number };

interface WorkerBroadcast {
  id: 0;
  name: "download-progress" | "model-loaded";
  payload: unknown;
  type: "event";
}

export type WorkerReply =
  | { id: number; type: "result"; value: unknown }
  | { id: number; type: "stream-part"; part: unknown }
  | { id: number; type: "stream-end" }
  | { id: number; type: "error"; message: string; name?: string }
  | WorkerBroadcast;

interface WorkerTransport<TSend, TReceive> {
  onExit(handler: (reason: string) => void): void;
  onMessage(handler: (message: TReceive) => void): void;
  send(message: TSend): void;
}

export type HostTransport = WorkerTransport<WorkerRequest, WorkerReply> & {
  terminate?(): void;
};
export type WorkerSideTransport = WorkerTransport<WorkerReply, WorkerRequest>;

export function encodeAudio(audio: Float32Array): string {
  return Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength).toString(
    "base64"
  );
}

export function decodeAudio(encoded: string): Float32Array {
  const buf = Buffer.from(encoded, "base64");
  return new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
}
