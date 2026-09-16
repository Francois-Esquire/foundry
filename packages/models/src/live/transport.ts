import type { Media } from "../types";
import type { LiveAccess, LiveDirection, LiveTarget } from "./types";

/**
 * One outbound message. `correlation` is the core's own id for this send; a
 * transport that can echo an id back on the message it answers must echo this
 * one, because it is what carries committed-time Direction attribution.
 */
export interface TransportSend {
  readonly correlation: string;
  readonly direction: LiveDirection;
  readonly frame?: Media;
  readonly frameId?: string;
  readonly references?: readonly Media[];
}

/** One delivered output on the socket path. */
export interface TransportMessage {
  /** The `correlation` of the send this answers, when the vendor echoes it. */
  readonly correlation?: string;
  readonly media: Media;
}

/**
 * Received media on a continuous session, opaque to the core: the browser
 * transport yields a DOM `MediaStream`, the Node one a werift track, and the
 * core only routes it to whichever host adapter opened the interaction.
 */
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
  /**
   * Resolves when the transport has accepted the message. The core holds at
   * most one pending frame while this is outstanding, so acceptance — not
   * delivery — is what releases the pending slot.
   */
  send(message: TransportSend): Promise<void>;
}

/** What a transport is given at `open`. `feed` is host-shaped and opaque here. */
export interface TransportOptions {
  /** The opening Direction, for a transport whose first input opens the session. */
  readonly direction: LiveDirection;
  readonly feed?: unknown;
  /**
   * Passed on the Lucy path so the injected factory and the globals the Node
   * runtime installed are the same implementation. Absent in a browser.
   */
  readonly peerConnectionFactory?: (configuration: unknown) => unknown;
  readonly throttleMs?: number;
}

export type Connect = (
  target: LiveTarget,
  access: LiveAccess,
  options: TransportOptions,
  handlers: TransportHandlers
) => Promise<Transport>;
