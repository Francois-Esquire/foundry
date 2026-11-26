import type { CoreRequest } from "../core";
import { connectFalSocket } from "./socket";
import { connectFalWebRtc } from "./webrtc";

export const falTransports: CoreRequest["connect"] = {
  socket: connectFalSocket,
  webrtc: connectFalWebRtc,
};
