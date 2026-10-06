import type { CoreRequest } from "./core";
import { connectFalSocket } from "./fal-socket";
import { connectFalWebRtc } from "./fal-webrtc";

/** The vendor transports both live entries open through; the core names none. */
export const falTransports: CoreRequest["connect"] = {
  socket: connectFalSocket,
  webrtc: connectFalWebRtc,
};
