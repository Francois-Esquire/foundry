import type { RealtimeConnection } from "@fal-ai/client";

import type { Media } from "../types";
import { falClientFor } from "./fal-access";
import type { Connect, Transport } from "./transport";

/**
 * A vendor result frame, read from the pinned tarball's declarations:
 * `RealtimeEditOutput.images` is `RawImage[]`, whose `content` is base64 and
 * whose `content_type` defaults to `image/jpeg` (`types/endpoints.d.ts`).
 * `request_id` is the client's own echo field (`realtime/protocol.d.ts`
 * `WithRequestId`), which carries committed-time Direction attribution back.
 */
interface FalRealtimeResult {
  readonly images?: readonly {
    readonly content?: string;
    readonly content_type?: string;
  }[];
  readonly request_id?: string;
}

/**
 * A close arrives on `onClose` only for a NORMAL closure (code 1000). Every
 * abnormal closure reaches `onError` as an `ApiError` whose `status` is the
 * WebSocket close code (`realtime.js` `ws.onclose`), while message-level errors
 * use 400 and the unknown-error path uses 500 — so a status at or above 1000 is
 * the only signal this client offers for "the socket went away".
 */
const WEBSOCKET_CLOSE_STATUS = 1000;

export const connectFalSocket: Connect = (target, access, _options, handlers) =>
  Promise.resolve().then((): Transport => {
    const client = falClientFor(access);

    const connection: RealtimeConnection<Record<string, unknown>> =
      client.realtime.connect(target.modelId, {
        // No `tokenExpirationSeconds`: supplying it alongside a custom
        // `tokenProvider` arms the client's refresh-at-90% timer, and this
        // interaction must present the token it was given and never renew it.
        ...(access.kind === "token"
          ? { tokenProvider: () => Promise.resolve(access.token) }
          : {}),
        onClose: (event: { code: number; reason: string }) => {
          handlers.close("disconnected", event.reason);
        },
        onError: (error: { status?: number; message?: string }) => {
          if ((error.status ?? 0) >= WEBSOCKET_CLOSE_STATUS) {
            handlers.close("disconnected", error.message);
            return;
          }
          handlers.error(error);
        },
        onResult: (result: FalRealtimeResult) => {
          const media = mediaOf(result);
          if (media === null) {
            return;
          }
          handlers.message({
            media,
            ...(result.request_id === undefined
              ? {}
              : { correlation: result.request_id }),
          });
        },
      });

    return {
      close() {
        connection.close();
      },
      send(message) {
        connection.send({
          prompt: message.direction.prompt,
          request_id: message.correlation,
          ...(message.direction.settings ?? {}),
          // `RealtimeEditInput.image_url` takes a base64 data URI, and
          // `Lucy25RealtimeInput.reference_image_url` is the only reference
          // field the pinned tarball declares on a realtime endpoint. An
          // endpoint with no such input ignores it.
          ...(message.references?.[0] === undefined
            ? {}
            : { reference_image_url: encode(message.references[0]) }),
          ...(message.frame === undefined
            ? {}
            : { image_url: encode(message.frame) }),
        });
        // `RealtimeConnection.send` is fire-and-forget and the client throttles
        // and buffers behind it, so acceptance is the call returning. The
        // pending slot is released here rather than at vendor receipt.
        return Promise.resolve();
      },
    };
  });

/**
 * Bounded so the argument list stays small. `String.fromCharCode(...bytes)`
 * spreads every byte as a call argument, which overflows the stack on V8 at
 * roughly 200 KB — the size of an ordinary 1080p frame, and this is the
 * per-frame path. Bun tolerates the spread, so the package's own runner cannot
 * reproduce the overflow; the bound is what keeps every host safe.
 */
const ENCODE_CHUNK_BYTES = 32 * 1024;

function encode(media: Media): string {
  let binary = "";
  for (
    let offset = 0;
    offset < media.bytes.length;
    offset += ENCODE_CHUNK_BYTES
  ) {
    binary += String.fromCharCode(
      ...media.bytes.subarray(offset, offset + ENCODE_CHUNK_BYTES)
    );
  }
  return `data:${media.mime};base64,${btoa(binary)}`;
}

function mediaOf(result: FalRealtimeResult): Media | null {
  const image = result.images?.[0];
  if (image?.content === undefined) {
    return null;
  }
  const binary = atob(image.content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return { bytes, mime: image.content_type ?? "image/jpeg" };
}
