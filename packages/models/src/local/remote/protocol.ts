import type {
  EmbeddingModelV4CallOptions,
  LanguageModelV4CallOptions,
} from "@ai-sdk/provider";

import type { TranscribeOptions } from "../../types";

/**
 * The bridge protocol between a host process and the local-inference worker.
 * Transport-agnostic: messages are structured-clone-safe objects (no functions,
 * no AbortSignal — cancellation is its own message). One request may produce
 * one terminal reply (`result`/`error`) and, for streams, any number of
 * `stream-part` messages before a `stream-end`.
 */

/** Call options with the non-serializable members stripped for transit. */
export type WireCallOptions = Omit<
  LanguageModelV4CallOptions,
  "abortSignal" | "headers"
>;

export type WireEmbedOptions = Omit<
  EmbeddingModelV4CallOptions,
  "abortSignal" | "headers"
>;

/** Inference ops carry the wire model id; management ops carry the catalog id. */
export type WorkerRequest =
  | { id: number; op: "generate"; model: string; options: WireCallOptions }
  | { id: number; op: "stream"; model: string; options: WireCallOptions }
  | { id: number; op: "embed"; model: string; options: WireEmbedOptions }
  | {
      id: number;
      op: "transcribe";
      model?: string;
      /** Base64 of the Float32Array PCM buffer — portable across transports. */
      audio: string;
      options: TranscribeOptions;
    }
  | { id: number; op: "download"; model: string }
  | { id: number; op: "preload" }
  | { id: number; op: "status" }
  | { id: number; op: "progress"; model: string }
  | { id: number; op: "set-offline"; offline: boolean }
  | { id: number; op: "cancel"; target: number };

/** Provider events forwarded from the worker, outside any request. */
export interface WorkerBroadcast {
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

/**
 * The seam both sides speak through. Implementations: a Node IPC channel
 * (production), an in-memory cross-wired pair (tests). `onExit` fires when the
 * far side is gone — the provider uses it to reject in-flight requests.
 */
export interface WorkerTransport<TSend, TReceive> {
  onExit(handler: (reason: string) => void): void;
  onMessage(handler: (message: TReceive) => void): void;
  send(message: TSend): void;
}

export type HostTransport = WorkerTransport<WorkerRequest, WorkerReply>;
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
