import type { MediaStreamTrack } from "werift";
import { modelErrors } from "../../errors";
import type { Media } from "../../types";
import type { HostAdapter } from "../core";
import { openCore } from "../core";
import { connectFalSocket } from "../fal-socket";
import { connectFalWebRtc } from "../fal-webrtc";
import type {
  LiveAccess,
  LiveInteraction,
  LiveOptions,
  LiveTarget,
} from "../types";
import type { LiveRecording } from "./record";
import { startRecording } from "./record";
import { installWebRtc, peerConnection } from "./runtime";

export type {
  JsonValue,
  LiveAccess,
  LiveClosedReason,
  LiveDirection,
  LiveInteraction,
  LiveOptions,
  LiveResult,
  LiveState,
  LiveTarget,
} from "../types";
export type { LiveRecording, RecordedSegment } from "./record";
export { installWebRtc, peerConnection };

export type LiveTrack = MediaStreamTrack;

export interface NodeLiveOptions extends LiveOptions {
  readonly feed?: LiveTrack;
  readonly onData?: (raw: string) => void;
  readonly onTrack?: (track: LiveTrack, direction: number) => void;
}

/**
 * No `attach`: sampling frames out of a Node media track would mean decoding,
 * which the no-transcoding constraint excludes. A Node caller on the socket
 * path calls `supply` per frame.
 */
export interface NodeLiveInteraction extends LiveInteraction {
  record(destination: string): LiveRecording;
  readonly tracks: readonly LiveTrack[];
}

export async function open(
  target: LiveTarget,
  access: LiveAccess,
  options: NodeLiveOptions
): Promise<NodeLiveInteraction> {
  installWebRtc();

  const tracks: LiveTrack[] = [];
  const adapter: HostAdapter = {
    data: (raw) => {
      options.onData?.(raw);
    },
    media: (media, direction) => {
      for (const track of tracksOf(media)) {
        tracks.push(track);
        // Only vendor loss is terminal, and a host that throws forwarding one
        // track must not cost it the rest of the session's media. The failure
        // is the host's to recover; the session neither ends nor stalls.
        try {
          options.onTrack?.(track, direction);
        } catch {
          // Deliberately swallowed. See above.
        }
      }
    },
  };

  const core = await openCore({
    access,
    adapter,
    connect: { socket: connectFalSocket, webrtc: connectFalWebRtc },
    // Both extensions take a `localStream`, so a Node caller's single track is
    // wrapped in the `MediaStream` the runtime installed — the same
    // constructor the client itself reaches for. It happens here, in the entry
    // that owns Node media, rather than in a transport the browser shares.
    // Presence is preserved exactly, so the fact checks are unaffected.
    options:
      options.feed === undefined
        ? options
        : { ...options, feed: asStream(options.feed) },
    // The injected factory and the installed globals are the same class.
    peerConnectionFactory: (configuration) =>
      peerConnection(configuration as Parameters<typeof peerConnection>[0]),
    target,
  });

  let recording: LiveRecording | null = null;
  core.addTeardown(() => {
    // Whoever holds the LiveRecording still gets its segment: `stop` is
    // idempotent and resolves the same promise for both callers.
    void recording?.stop();
  });

  return {
    close: () => {
      core.close();
    },
    direct: (direction) => core.direct(direction),
    get direction() {
      return core.direction;
    },
    record(destination) {
      if (core.state !== "open") {
        throw modelErrors.LIVE_RECORDING_REFUSED({
          reason: "the interaction is no longer open",
        });
      }
      const started = startRecording(destination, {
        active: recording !== null,
        get direction() {
          return core.direction;
        },
        tracks,
      });
      // One *active* recording, not one ever: the slot is released when this
      // one stops, so a caller can record a second segment on the same session.
      const handle: LiveRecording = {
        stop: async () => {
          const segment = await started.stop();
          if (recording === handle) {
            recording = null;
          }
          return segment;
        },
      };
      recording = handle;
      return handle;
    },
    reference: (media: readonly Media[]) => {
      core.reference(media);
    },
    get state() {
      return core.state;
    },
    supply: (frame, id) => {
      core.supply(frame, id);
    },
    get tracks(): readonly LiveTrack[] {
      return tracks;
    },
  };
}

/**
 * The client kernel publishes received media as a stream, and both extensions
 * build it from the `MediaStream` this runtime installed — so its tracks are
 * werift tracks. A track handed over directly is accepted too.
 */
function tracksOf(media: unknown): LiveTrack[] {
  if (typeof media !== "object" || media === null) {
    return [];
  }
  const stream = media as { getTracks?: () => LiveTrack[]; kind?: unknown };
  if (typeof stream.getTracks === "function") {
    return stream.getTracks();
  }
  return typeof stream.kind === "string" ? [media as LiveTrack] : [];
}

/** A Node feed is one track; both extensions negotiate a stream. */
function asStream(feed: LiveTrack): unknown {
  const Stream = (
    globalThis as { MediaStream?: new (tracks: unknown[]) => unknown }
  ).MediaStream;
  if (Stream === undefined) {
    throw modelErrors.WEBRTC_UNAVAILABLE({ symbol: "MediaStream" });
  }
  return new Stream([feed]);
}
