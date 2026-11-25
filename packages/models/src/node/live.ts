import type { MediaStreamTrack } from "werift";
import { modelErrors } from "../errors";
import type { HostAdapter } from "../live/core";
import { openCore } from "../live/core";
import { falTransports } from "../live/fal/transports";
import type {
  LiveAccess,
  LiveInteraction,
  LiveOptions,
  LiveTarget,
} from "../live/types";
import type { Media } from "../media";
import type { LiveRecording } from "./live/record";
import { startRecording } from "./live/record";
import { installWebRtc, peerConnection } from "./live/runtime";

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
} from "../live/types";
export type { LiveRecording, RecordedSegment } from "./live/record";
// biome-ignore lint/performance/noBarrelFile: Preserve the declared @foundry/models/node/live runtime compatibility API.
export { installWebRtc, peerConnection } from "./live/runtime";

export type LiveTrack = MediaStreamTrack;

export interface NodeLiveOptions extends LiveOptions {
  readonly feed?: LiveTrack;
  readonly onData?: (raw: string) => void;
  readonly onTrack?: (track: LiveTrack, direction: number) => void;
}

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
        try {
          options.onTrack?.(track, direction);
        } catch {
          // biome-ignore lint/complexity/noUselessContinue: A failed callback cannot suppress the remaining tracks.
          continue;
        }
      }
    },
  };

  const core = await openCore({
    access,
    adapter,
    connect: falTransports,
    options:
      options.feed === undefined
        ? options
        : { ...options, feed: asStream(options.feed) },
    peerConnectionFactory: (configuration) =>
      peerConnection(configuration as Parameters<typeof peerConnection>[0]),
    target,
  });

  let recording: LiveRecording | null = null;
  core.addTeardown(() => {
    recording?.stop();
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

function asStream(feed: LiveTrack): unknown {
  const Stream = (
    globalThis as { MediaStream?: new (tracks: unknown[]) => unknown }
  ).MediaStream;
  if (Stream === undefined) {
    throw modelErrors.WEBRTC_UNAVAILABLE({ symbol: "MediaStream" });
  }
  return new Stream([feed]);
}
