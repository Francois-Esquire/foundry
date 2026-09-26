export const trackIds = ["current", "wind", "waves"] as const;
export type TrackId = (typeof trackIds)[number];

export function createPlayback() {
  let sourceTime: number | null = null;
  let time = 0;
  let playing = true;
  let speed = 1;
  const tracks = Object.fromEntries(
    trackIds.map((id) => [id, { playing: true, time: 0 }])
  ) as Record<TrackId, { time: number; playing: boolean }>;
  return {
    play(value: boolean) {
      playing = value;
      sourceTime = null;
    },
    restore(value: PlaybackSnapshot) {
      time = value.time;
      playing = value.playing;
      speed = value.speed;
      sourceTime = null;
      for (const id of trackIds) {
        Object.assign(tracks[id], value.tracks[id]);
      }
    },
    running: () => playing && trackIds.some((id) => tracks[id].playing),
    seek(seconds: number) {
      time = Math.max(0, seconds);
      for (const id of trackIds) {
        tracks[id].time = time;
      }
    },
    snapshot: () => ({
      playing,
      speed,
      time,
      tracks: Object.fromEntries(
        trackIds.map((id) => [id, { ...tracks[id] }])
      ) as typeof tracks,
    }),
    speed(value: number) {
      speed = value;
    },
    tick(milliseconds: number) {
      const delta =
        sourceTime === null
          ? 0
          : (Math.max(0, milliseconds - sourceTime) / 1000) * speed;
      sourceTime = milliseconds;
      if (!(playing && trackIds.some((id) => tracks[id].playing))) {
        return;
      }
      time += delta;
      for (const id of trackIds) {
        if (tracks[id].playing) {
          tracks[id].time += delta;
        }
      }
    },
    track(id: TrackId, value: boolean) {
      tracks[id].playing = value;
    },
  };
}

export interface PlaybackSnapshot {
  playing: boolean;
  speed: number;
  time: number;
  tracks: Record<TrackId, { time: number; playing: boolean }>;
}
