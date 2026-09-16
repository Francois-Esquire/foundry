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

/**
 * The one place this package names a WebRTC library.
 *
 * werift's own default offers `[OPUS, PCMU]` audio and `[VP8]` video. PCMU is
 * not a codec the webm writer carries, so the default applied at construction
 * here is narrowed to VP8/Opus — the pair the recorder can mux without
 * decoding.
 *
 * This is also where the decided reversal ladder is applied: a codec failure
 * against a vendor endpoint is answered by widening this list with werift's
 * `useH264`/`useVP9`/`useAV1X`, and only an SDP or DTLS failure that widening
 * cannot fix escalates to the alternate implementation.
 */
function withCodecDefault(
  config?: RTCPeerConnectionConfig
): RTCPeerConnectionConfig {
  return {
    ...config,
    codecs: config?.codecs ?? { audio: [useOPUS()], video: [useVP8()] },
  };
}

/** The peer-connection class installed on `globalThis`, carrying the default. */
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

/**
 * Installs the WebRTC symbols the vendor client constructs from globals, only
 * where they are absent. Idempotent, and it never overrides a browser's own.
 */
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
    } catch {
      throw modelErrors.WEBRTC_UNAVAILABLE({ symbol: name });
    }
    if (!(name in globalThis)) {
      throw modelErrors.WEBRTC_UNAVAILABLE({ symbol: name });
    }
  }
}

/**
 * The same class the runtime installed, so a host's own connection and the
 * vendor connection share one implementation and can exchange tracks.
 */
export function peerConnection(config?: RTCConfiguration): RTCPeerConnection {
  installWebRtc();
  // `globalThis.RTCPeerConnection` is DOM-typed in this package's lib, and
  // what stands there in Node is werift's class — structurally unrelated. The
  // read goes through `unknown` rather than typing the seam as DOM.
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
