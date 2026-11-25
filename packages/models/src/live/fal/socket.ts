import type { RealtimeConnection } from "@fal-ai/client";

import type { Media } from "../../media";
import type { Connect, Transport } from "../transport";
import { type FalClientFactory, falClientFor } from "./access";

interface FalRealtimeResult {
  readonly images?: readonly {
    readonly content?: string;
    readonly content_type?: string;
  }[];
  readonly request_id?: string;
}

const WEBSOCKET_CLOSE_STATUS = 1000;

export const falSocketTransport =
  (create?: FalClientFactory): Connect =>
  (target, access, _options, handlers) =>
    Promise.resolve().then((): Transport => {
      const client = falClientFor(access, create);

      const connection: RealtimeConnection<Record<string, unknown>> =
        client.realtime.connect(target.modelId, {
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
            ...(message.references?.[0] === undefined
              ? {}
              : { reference_image_url: encode(message.references[0]) }),
            ...(message.frame === undefined
              ? {}
              : { image_url: encode(message.frame) }),
          });
          return Promise.resolve();
        },
      };
    });

export const connectFalSocket = falSocketTransport();

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
