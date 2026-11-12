import type { OutputMeans } from "~/generation/model-output";
import type { ImageCodec } from "~/generation/raster/image-codec";
import type { Workspace } from "./workspace";

/** What a run is made with, and its model output kept with. */
export interface RunMeans extends OutputMeans {
  /** Says when a run started, ended and produced its output. */
  readonly clock: () => Date;
  readonly codec: ImageCodec;
  /** Replaces the network for model calls in tests. */
  readonly modelFetch?: typeof fetch;
  readonly newId: () => string;
  /** The provider key as it stands when a strategy is built. Empty when there is none. */
  readonly providerKey: () => string;
  readonly workspace: Workspace;
}
