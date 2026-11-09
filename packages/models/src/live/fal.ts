import type { CoreRequest } from "./core";
import { connectFalSocket } from "./fal-socket";
import { connectFalWebRtc } from "./fal-webrtc";

export const falTransports: CoreRequest["connect"] = {
  socket: connectFalSocket,
  webrtc: connectFalWebRtc,
};
