import type { RealtimeOpenOptions } from "@fal-ai/client/realtime";

import { lucyRealtime, wma } from "@fal-ai/client/realtime";
import { modelErrors } from "../errors";
import { falClientFor } from "./fal-access";
import type { Connect, Transport } from "./transport";

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
      if (state === "closed") {
        handlers.close("disconnected", "session closed");
      }
    },
  };

  const localStream = (options.feed ?? null) as MediaStream | null;

  if (extension === "lucy") {
    const session = client.realtime.open(lucyRealtime(), {
      ...kernel,
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
      close();
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
