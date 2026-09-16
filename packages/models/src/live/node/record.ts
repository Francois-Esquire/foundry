import type { MediaStreamTrack } from "werift";

import { MediaRecorder } from "werift/nonstandard";

import { modelErrors } from "../../errors";

/**
 * Video codecs werift's webm writer carries; anything else is a refusal.
 *
 * The audio list is reachable only on a session that negotiates an audio
 * track. At this pin the WMA extension offers exactly one recv-only *video*
 * transceiver, so on the shipped `continuous` facts neither this list nor the
 * `audio/webm` mime below is reached. Both are kept because the codec check is
 * per received track, not per endpoint.
 */
const WEBM_VIDEO_CODECS = ["h264", "vp8", "vp9", "av1x"];
const WEBM_AUDIO_CODECS = ["opus"];

export interface RecordedSegment {
  readonly durationMs: number;
  readonly endedDirection: number;
  readonly mime: "video/webm" | "audio/webm";
  readonly path: string;
  readonly startedDirection: number;
}

export interface LiveRecording {
  stop(): Promise<RecordedSegment>;
}

/** What `record` needs from the interaction, so the recorder holds no state. */
export interface RecordContext {
  readonly active: boolean;
  readonly direction: number;
  readonly tracks: readonly MediaStreamTrack[];
}

export function startRecording(
  destination: string,
  context: RecordContext
): LiveRecording {
  if (context.active) {
    throw modelErrors.LIVE_RECORDING_REFUSED({
      reason: "a recording is already active on this interaction",
    });
  }
  if (context.tracks.length === 0) {
    throw modelErrors.LIVE_RECORDING_REFUSED({
      reason: "no track has been received yet",
    });
  }
  for (const track of context.tracks) {
    // Refusal, never a transcode: what the writer cannot carry is not re-encoded.
    const name = track.codec?.name.toLowerCase();
    const carried =
      track.kind === "audio" ? WEBM_AUDIO_CODECS : WEBM_VIDEO_CODECS;
    if (name === undefined || !carried.includes(name)) {
      throw modelErrors.LIVE_RECORDING_REFUSED({
        reason: `the webm writer does not carry the negotiated ${track.kind} codec "${name ?? "unknown"}"`,
      });
    }
  }

  const startedDirection = context.direction;
  const startedAt = Date.now();
  const hasVideo = context.tracks.some((track) => track.kind === "video");
  // Supplying `tracks` is what starts it: the constructor sets `numOfTracks`
  // and calls its own private `start` (`nonstandard/recorder/index.js`).
  const recorder = new MediaRecorder({
    path: destination,
    tracks: [...context.tracks],
  });
  let segment: Promise<RecordedSegment> | null = null;

  return {
    stop() {
      segment ??= Promise.resolve(recorder.stop()).then(() => ({
        durationMs: Date.now() - startedAt,
        endedDirection: context.direction,
        mime: hasVideo ? ("video/webm" as const) : ("audio/webm" as const),
        path: destination,
        startedDirection,
      }));
      return segment;
    },
  };
}
