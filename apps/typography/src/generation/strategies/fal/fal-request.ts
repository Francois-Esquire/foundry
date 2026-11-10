/** Calls to fal's HTTP API: one POST to run a model, one GET to fetch each file it made. */
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
const DETAIL_LIMIT = 300;

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
