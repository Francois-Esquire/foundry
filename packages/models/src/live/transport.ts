import type { Media } from "../types";
import type { LiveAccess, LiveDirection, LiveTarget } from "./types";

export interface TransportSend {
  readonly correlation: string;
  readonly direction: LiveDirection;
  readonly frame?: Media;
  readonly frameId?: string;
  readonly references?: readonly Media[];
}

interface TransportMessage {
  readonly correlation?: string;
  readonly media: Media;
}

export type TransportMedia = unknown;

export interface TransportHandlers {
  close(reason: "disconnected", message?: string): void;
  data(raw: string): void;
  error(error: unknown): void;
  media(media: TransportMedia): void;
  message(message: TransportMessage): void;
}

export interface Transport {
  close(): void;
  send(message: TransportSend): Promise<void>;
}

export interface TransportOptions {
  readonly direction: LiveDirection;
  readonly feed?: unknown;
  readonly peerConnectionFactory?: (configuration: unknown) => unknown;
  readonly throttleMs?: number;
}

export type Connect = (
  target: LiveTarget,
  access: LiveAccess,
  options: TransportOptions,
  handlers: TransportHandlers
) => Promise<Transport>;
