/**
 * Sampling a `MediaStream` into frames, for `attach` on the socket path. It is
 * its own module so the browser entry can be imported — and proven free of any
 * Node module — in an environment that has no `<video>` pipeline to sample.
 */
export interface Sampler {
  stop(): void;
}

export function sampleStream(
  stream: MediaStream,
  intervalMs: number,
  onFrame: (frame: { bytes: Uint8Array; mime: string }) => void
): Sampler {
  if (typeof document === "undefined") {
    throw new Error("no media stack is available to sample a feed");
  }
  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  const canvas = document.createElement("canvas");
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || video.videoWidth === 0) {
      return;
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (context === null) {
      return;
    }
    context.drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (stopped || blob === null) {
        return;
      }
      void blob.arrayBuffer().then((bytes) => {
        if (stopped) {
          return;
        }
        onFrame({ bytes: new Uint8Array(bytes), mime: blob.type });
      });
    }, "image/jpeg");
  }, intervalMs);
  void video.play().catch(() => {
    // A stream that will not play yields no frames; it is not a state change.
  });
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      video.srcObject = null;
    },
  };
}
