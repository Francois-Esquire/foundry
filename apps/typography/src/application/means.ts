/**
 * What an application is opened with. This is the one place a reader, a
 * builder, an image codec, an artifact manager, a clock, a timer and an id
 * source are chosen: every use case below takes them from here and none
 * falls back to its own.
 */
import type { Artifacts } from "@foundry/artifacts";
import type { ImageCodec } from "~/generation/raster/image-codec";
import type {
  FilesRun,
  RecordedRunSource,
} from "~/generation/strategies/recorded/source";
import type { FontBuilder } from "~/packaging/building";
import type { FontReader } from "~/typeface/reading";

export interface ApplicationMeans {
  /** Where fonts, photographs, model output, exports and the project are kept. */
  readonly artifacts: Artifacts;
  readonly builder: FontBuilder;
  /** Says when something happened. */
  readonly clock: () => Date;
  readonly codec: ImageCodec;
  /** Replaces the network for model calls in tests. The platform's fetch when absent. */
  readonly modelFetch?: typeof fetch;
  /** Ids for revisions, runs, candidates and notices. */
  readonly newId: () => string;
  /** The model provider's key. Without one no model is called. */
  readonly providerKey?: string;
  readonly reader: FontReader;
  /**
   * The recorded run kept at a location, with every file it has: a
   * directory on disk in Node. Refuses with a sentence when there is none.
   * A command replays the run it is given and keeps its files.
   */
  readonly runAt: (location: string) => Promise<FilesRun>;
  /**
   * The recorded runs served with the app, which a screen's sessions list
   * and replay.
   */
  readonly servedRuns: RecordedRunSource;
  /**
   * Milliseconds since any fixed moment, for timing a step. It measures how
   * long something took, never when it happened.
   */
  readonly timer: () => number;
}
