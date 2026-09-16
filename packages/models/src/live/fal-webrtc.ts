import type { RealtimeOpenOptions } from "@fal-ai/client/realtime";

import { lucyRealtime, wma } from "@fal-ai/client/realtime";
import { modelErrors } from "../errors";
import { falClientFor } from "./fal-access";
import type { Connect, Transport } from "./transport";

/**
 * Which extension opens a `continuous` endpoint is decided here and nowhere
 * else — not in a Capability fact, and never from a model-name pattern.
 *
 * `lucy` owns a closed set of endpoints and exposes `supports(endpointId)`
 * over it, so it is asked rather than matched. `wma` deliberately ships no
 * `supports()`: its own comment says whether a model speaks WMA is *declared*
 * by the caller naming the extension and "never inferred from a string". This
 * line is that declaration — WMA is the default transport for every
 * `continuous` endpoint Lucy does not claim.
 */
function selectExtension(endpointId: string): "lucy" | "wma" {
  return lucyRealtime().supports?.(endpointId) === true ? "lucy" : "wma";
}

export const connectFalWebRtc: Connect = async (
  target,
  access,
  options,
  handlers
) => {
  const extension = selectExtension(target.modelId);
  if (access.kind === "token" && extension === "wma") {
    // `LucyRealtimeOptions` declares `tokenProvider`; `WmaOptions` and the
    // kernel's `RealtimeOpenOptions` declare no authentication option at all,
    // so there is no declared place to put a token on this path. Refusing is
    // the contract's "rejected by the transport"; guessing a config key is not.
    throw modelErrors.LIVE_ACCESS_UNAVAILABLE({
      reason: `the WMA transport declares no token option, so ${target.modelId} needs proxy or credential access`,
    });
  }
  const client = falClientFor(access);

  const kernel: RealtimeOpenOptions = {
    endpointId: target.modelId,
    onData: (raw) => {
      handlers.data(raw);
    },
    onError: (error) => {
      handlers.close("disconnected", messageOf(error));
    },
    onMedia: (stream) => {
      handlers.media(stream);
    },
    onState: (state) => {
      if (state === "failed") {
        handlers.close("disconnected", "session failed");
      }
      // `closed` is reported too, because an extension can end its own session
      // through `context.close()` when the runner reports the remote session
      // finished — a vendor-side ending with no `failed` and no error. A close
      // this interaction asked for reaches the core after it is already
      // terminal, so the echo is dropped there rather than fired twice.
      if (state === "closed") {
        handlers.close("disconnected", "session closed");
      }
    },
  };

  // The feed is handed to the extension as it builds its offer, so it is in
  // the SDP; there is no later attach and no renegotiation. Each entry hands
  // over a stream already shaped for its own host.
  const localStream = (options.feed ?? null) as MediaStream | null;

  if (extension === "lucy") {
    const session = client.realtime.open(lucyRealtime(), {
      ...kernel,
      // Lucy TRANSMITS this to start its session (`lucy.js:296`); it is not a
      // stored default. So the opening Direction leaves here, and the core's
      // own opening send is swallowed below — otherwise a Lucy session would
      // begin with two generation requests.
      input: {
        prompt: options.direction.prompt,
        ...(options.direction.settings ?? {}),
      },
      localStream,
      ...(access.kind === "token"
        ? { tokenProvider: () => Promise.resolve(access.token) }
        : {}),
      ...(options.peerConnectionFactory === undefined
        ? {}
        : {
            peerConnectionFactory: options.peerConnectionFactory as (
              configuration: RTCConfiguration
            ) => RTCPeerConnection,
          }),
    });
    await session.ready;
    return sending(
      (input) => {
        session.send(input);
      },
      session.close.bind(session),
      { swallowOpeningSend: true }
    );
  }

  // WMA declares no `input`, so nothing has been sent when this resolves and
  // the core's opening send is the session's first Direction.
  const session = client.realtime.open(wma(target.modelId), {
    ...kernel,
    localStream,
  });
  await session.ready;
  return sending(
    (input) => {
      session.send(input);
    },
    session.close.bind(session),
    { swallowOpeningSend: false }
  );
};

function sending(
  send: (input: Record<string, unknown>) => void,
  close: () => void | Promise<void>,
  options: { swallowOpeningSend: boolean }
): Transport {
  let opened = false;
  return {
    close() {
      void close();
    },
    send(message) {
      const opening = !opened;
      opened = true;
      if (opening && options.swallowOpeningSend) {
        return Promise.resolve();
      }
      send({
        prompt: message.direction.prompt,
        request_id: message.correlation,
        ...(message.direction.settings ?? {}),
      });
      return Promise.resolve();
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
