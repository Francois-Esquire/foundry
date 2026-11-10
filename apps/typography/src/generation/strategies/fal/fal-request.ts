/**
 * Calls to fal's HTTP API: one POST to run a model, one GET to fetch each file
 * it made, and an upload to fal's storage for a picture a model has to fetch.
 */
import { type EncodedFile, fromDataUri } from "../../raster/image-codec";
import { ModelRequestError } from "../model-client";
import type { Availability } from "../strategy";

type Fetch = typeof fetch;

export interface FalOptions {
  /** Milliseconds now. Injected so tests can measure latency without waiting. */
  readonly clock?: () => number;
  /** The model endpoint, for example `openai/gpt-image-2.6/flare/edit`. */
  readonly endpoint?: string;
  readonly fetch?: Fetch;
  /** The fal API key. Without one the client reports itself unavailable. */
  readonly key?: string;
}

/** One file in a fal response. */
interface FalFile {
  readonly content_type?: string;
  readonly url?: string;
}

const HOST = "https://fal.run";
const STORAGE_HOST = "https://rest.fal.ai";
const DETAIL_LIMIT = 300;
/** An uploaded picture is only needed for the one call that follows it. */
const UPLOAD_LIFETIME_SECONDS = 3600;
const EXTENSIONS: Readonly<Record<string, string | undefined>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
};

export const falAvailability = (key: string | undefined): Availability =>
  key
    ? { available: true }
    : {
        available: false,
        reason:
          "No fal API key was supplied, so this model cannot be called. Add a key to use it.",
      };

/** Runs a model and returns the files it lists under `images`, with the time the call took. */
export const runFalModel = async (
  options: FalOptions & { readonly endpoint: string },
  body: Readonly<Record<string, unknown>>,
  signal: AbortSignal | undefined
): Promise<{
  readonly files: readonly FalFile[];
  readonly latencyMs: number;
}> => {
  if (!options.key) {
    throw new ModelRequestError("No fal API key was supplied.");
  }
  const send = options.fetch ?? fetch;
  const clock = options.clock ?? (() => performance.now());
  const started = clock();
  const response = await send(`${HOST}/${options.endpoint}`, {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Key ${options.key}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, DETAIL_LIMIT);
    throw new ModelRequestError(
      `fal answered ${response.status} for ${options.endpoint}: ${detail}`,
      response.status
    );
  }
  const answer = (await response.json()) as { images?: readonly FalFile[] };
  const files = answer.images ?? [];
  if (files.length === 0) {
    throw new ModelRequestError(
      `fal returned no files for ${options.endpoint}.`
    );
  }
  return { files, latencyMs: Math.round(clock() - started) };
};

/** Fetches a file a model made. A data URI is read in place. */
export const downloadFalFile = async (
  options: FalOptions,
  file: FalFile,
  fallbackType: string,
  signal: AbortSignal | undefined
): Promise<EncodedFile> => {
  if (!file.url) {
    throw new ModelRequestError("fal listed a file without a URL.");
  }
  const inline = fromDataUri(file.url);
  if (inline) {
    return inline;
  }
  const response = await (options.fetch ?? fetch)(file.url, { signal });
  if (!response.ok) {
    throw new ModelRequestError(
      `The file fal made could not be fetched (${response.status}).`,
      response.status
    );
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    mediaType:
      file.content_type ?? response.headers.get("content-type") ?? fallbackType,
  };
};

const refuseUpload = async (response: Response, step: string) => {
  const detail = (await response.text()).slice(0, DETAIL_LIMIT);
  return new ModelRequestError(
    `fal's storage answered ${response.status} when ${step}: ${detail}`,
    response.status
  );
};

/**
 * Puts a file on fal's storage and returns its address there. Some models
 * fetch their reference pictures themselves and refuse one sent inside the
 * request, so the picture has to be somewhere they can reach. The file is
 * asked to expire after an hour. The key goes to fal's own host only, never
 * to the address the bytes are sent to.
 */
export const uploadFalFile = async (
  options: FalOptions,
  file: EncodedFile,
  name: string,
  signal: AbortSignal | undefined
): Promise<string> => {
  if (!options.key) {
    throw new ModelRequestError("No fal API key was supplied.");
  }
  const send = options.fetch ?? fetch;
  const started = await send(
    `${STORAGE_HOST}/storage/upload/initiate?storage_type=fal-cdn-v3`,
    {
      body: JSON.stringify({
        content_type: file.mediaType,
        file_name: `${name}.${EXTENSIONS[file.mediaType] ?? "bin"}`,
      }),
      headers: {
        Authorization: `Key ${options.key}`,
        "Content-Type": "application/json",
        "X-Fal-Object-Lifecycle": JSON.stringify({
          expiration_duration_seconds: UPLOAD_LIFETIME_SECONDS,
        }),
      },
      method: "POST",
      signal,
    }
  );
  if (!started.ok) {
    throw await refuseUpload(started, "asked for a place to put a picture");
  }
  const place = (await started.json()) as {
    file_url?: string;
    upload_url?: string;
  };
  if (!(place.file_url && place.upload_url)) {
    throw new ModelRequestError(
      "fal's storage gave no address to put a picture at."
    );
  }
  const stored = await send(place.upload_url, {
    body: new Blob([file.bytes as Uint8Array<ArrayBuffer>], {
      type: file.mediaType,
    }),
    headers: { "Content-Type": file.mediaType },
    method: "PUT",
    signal,
  });
  if (!stored.ok) {
    throw await refuseUpload(stored, "sent a picture");
  }
  return place.file_url;
};
