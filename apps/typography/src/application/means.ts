/**
 * What an application is opened with. This is the one place a reader, a
 * builder, an image codec, an artifact manager, a clock and an id source are
 * chosen: every use case below takes them from here and none falls back to
 * its own.
 */
import type { Artifacts } from "@foundry/artifacts";
import type { ImageCodec } from "~/generation/raster/image-codec";
import type { FontBuilder } from "~/packaging/building";
import type { FontReader } from "~/typeface/reading";

export interface ApplicationMeans {
  /** Where fonts, photographs, model output, exports and the project are kept. */
  readonly artifacts: Artifacts;
  readonly builder: FontBuilder;
  readonly codec: ImageCodec;
  /** Replaces the network for model calls in tests. The platform's fetch when absent. */
  readonly modelFetch?: typeof fetch;
  /** Ids for revisions, runs, candidates and notices. */
  readonly newId: () => string;
  /** The current time as an ISO 8601 string. */
  readonly now: () => string;
  /** The model provider's key. Without one no model is called. */
  readonly providerKey?: string;
  readonly reader: FontReader;
  /**
   * Reads the files of a recorded run from where it is kept, by file name:
   * a directory on disk in Node. Rejects with a sentence when there is none.
   */
  readonly readRecordedRun: (
    location: string
  ) => Promise<ReadonlyMap<string, Uint8Array>>;
}
