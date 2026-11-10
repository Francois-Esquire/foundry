/**
 * The ports for model providers. A client takes a prompt and reference
 * images and returns one file, with what the call used. Strategies know
 * these interfaces and nothing about any provider behind them.
 */
import type { EncodedFile } from "../raster/image-codec";
import type { Availability } from "./strategy";

interface ModelCall {
  readonly prompt: string;
  /** Pictures the model is shown, the style reference sheet first. */
  readonly referenceImages: readonly EncodedFile[];
  readonly signal?: AbortSignal;
  /** The size of sheet asked for, in pixels. A model may only honour its shape. */
  readonly size: { readonly height: number; readonly width: number };
}

interface ModelUse {
  /** In US dollars, only when the provider states it for this call. */
  readonly costUsd?: number;
  readonly latencyMs: number;
  /** The model that answered, as the provider names it. */
  readonly model: string;
  /** The settings the call was made with, for the record. */
  readonly parameters: Readonly<Record<string, unknown>>;
}

interface ImageModelResult extends ModelUse {
  readonly image: EncodedFile;
}

interface VectorModelResult extends ModelUse {
  readonly svg: string;
}

/** A model that draws a picture from a prompt and reference pictures. */
export interface ImageModelClient {
  availability(): Availability;
  generate(call: ModelCall): Promise<ImageModelResult>;
  readonly model: string;
}

/** A model that answers with SVG directly. */
export interface VectorModelClient {
  availability(): Availability;
  generate(call: ModelCall): Promise<VectorModelResult>;
  readonly model: string;
}

/** A provider refused or failed a call. Carries the HTTP status when there was one. */
export class ModelRequestError extends Error {
  override readonly name = "ModelRequestError";
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}
