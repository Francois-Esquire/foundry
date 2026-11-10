/** The port for turning a bitmap into an outline. Any tracer can stand behind it. */
import type { Outline } from "~/typeface/outline";
import type { Bitmap } from "../raster/bitmap";

export interface TraceOptions {
  /** Turns sharper than this many degrees become corners. */
  readonly cornerAngle?: number;
  /** Shapes smaller than this many square pixels are dropped as specks. */
  readonly minimumArea?: number;
  /** The ink level, 0 to 255, that separates ink from paper. */
  readonly threshold?: number;
  /** How far, in pixels, a fitted curve may stray from the traced edge. */
  readonly tolerance?: number;
}

export interface Vectorizer {
  readonly id: string;
  /**
   * Traces the ink of a bitmap. The outline is in pixels with y up from the
   * bottom edge of the bitmap. Shapes run counter-clockwise and the counters
   * inside them clockwise.
   */
  trace(bitmap: Bitmap, options?: TraceOptions): Outline;
}
