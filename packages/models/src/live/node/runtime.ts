import type { RTCConfiguration, RTCPeerConnectionConfig } from "werift";

import {
  MediaStream,
  MediaStreamTrack,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
  useOPUS,
  useVP8,
} from "werift";

import { modelErrors } from "../../errors";

function withCodecDefault(
  config?: RTCPeerConnectionConfig
): RTCPeerConnectionConfig {
  return {
    ...config,
    codecs: config?.codecs ?? { audio: [useOPUS()], video: [useVP8()] },
  };
}

class FoundryPeerConnection extends RTCPeerConnection {
  constructor(config?: RTCPeerConnectionConfig) {
    super(withCodecDefault(config));
  }
}

function symbols(): Record<string, unknown> {
  return {
    MediaStream,
    MediaStreamTrack,
    RTCIceCandidate,
    RTCPeerConnection: FoundryPeerConnection,
    RTCSessionDescription,
  };
}

export function installWebRtc(): void {
  for (const [name, value] of Object.entries(symbols())) {
    if (name in globalThis) {
      continue;
    }
    if (value === undefined || value === null) {
      throw modelErrors.WEBRTC_UNAVAILABLE({ symbol: name });
    }
    try {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        value,
        writable: true,
      });
    } catch (cause) {
      const unavailable = modelErrors.WEBRTC_UNAVAILABLE({ symbol: name });
      unavailable.cause = cause;
      throw unavailable;
    }
    if (!(name in globalThis)) {
      throw modelErrors.WEBRTC_UNAVAILABLE({ symbol: name });
    }
  }
}

export function peerConnection(config?: RTCConfiguration): RTCPeerConnection {
  installWebRtc();
  const installed = (
    globalThis as unknown as {
      RTCPeerConnection?: new (
        config?: RTCPeerConnectionConfig
      ) => RTCPeerConnection;
    }
  ).RTCPeerConnection;
  if (installed === undefined) {
    throw modelErrors.WEBRTC_UNAVAILABLE({ symbol: "RTCPeerConnection" });
  }
  return new installed(config);
}
