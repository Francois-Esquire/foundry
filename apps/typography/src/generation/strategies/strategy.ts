/**
 * The port every way of producing glyphs stands behind. The pipeline asks
 * what a strategy can do and takes back raw output in one of three shapes.
 * It never learns which provider, if any, was involved.
 */
import type { AxisLocation } from "~/typeface/face";
import type { Outline } from "~/typeface/outline";
import type { OpenFace } from "~/typeface/reading";
import type { GlyphTarget } from "../plan/target";
import type { EncodedFile } from "../raster/image-codec";
import type { SheetLayout } from "../sheet/layout";
import type { StyleReference } from "../style/reference";

export type StrategyKind =
  | "image-model"
  | "procedural"
  | "recorded-run"
  | "vector-model";

/** Whether a strategy can run now. An unavailable one says why and is never swapped for another. */
export type Availability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

export interface StrategyRequest {
  readonly face: OpenFace;
  readonly location?: AxisLocation;
  readonly signal?: AbortSignal;
  readonly style: StyleReference;
  readonly targets: readonly GlyphTarget[];
}

/** A glyph a strategy drew straight into font units. */
export interface ProducedGlyph {
  readonly advance: number;
  readonly key: string;
  readonly outline: Outline;
  /** The rule that made it, in words a person can check. */
  readonly rule: string;
  /** What the rule is known to get wrong. */
  readonly weaknesses: readonly string[];
}

export type RawOutput =
  | { readonly kind: "outlines"; readonly glyphs: readonly ProducedGlyph[] }
  | {
      readonly kind: "sheet-image";
      readonly image: EncodedFile;
      /** The grid that was asked for. Extraction treats it as a hint. */
      readonly layout: SheetLayout;
    }
  | {
      readonly kind: "sheet-svg";
      readonly layout: SheetLayout;
      readonly svg: string;
    };

/** What a strategy sent to a model, kept so a run can be recorded and studied. */
export interface ModelRequest {
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly prompt: string;
  /** The style reference sheet the model was shown, as SVG. */
  readonly referenceSheet: string;
}

interface StrategyUsage {
  /** In US dollars, only when the provider states it. */
  readonly costUsd?: number;
  /** How long the model took, when that was measured or recorded. */
  readonly latencyMs?: number;
  readonly model?: string;
}

export interface StrategyOutput {
  /** When the output was produced. For a recorded run, when the model was called. */
  readonly createdAt: string;
  /**
   * The strategy that produced the output. For a recorded run this is the
   * strategy that was recorded, with `recorded` set.
   */
  readonly producedBy: string;
  readonly raw: RawOutput;
  /** True when the output was replayed from a saved run. */
  readonly recorded: boolean;
  /** The id of the recorded run, so a replay keeps the identity of the real one. */
  readonly runId?: string;
  readonly sent?: ModelRequest;
  /** Targets the strategy could not draw, each with the reason. */
  readonly unmade: readonly { readonly key: string; readonly reason: string }[];
  readonly usage: StrategyUsage;
}

export interface GenerationStrategy {
  availability(): Availability;
  generate(request: StrategyRequest): Promise<StrategyOutput>;
  readonly id: string;
  readonly kind: StrategyKind;
  readonly name: string;
}

/** Raised when `generate` is called on a strategy that reported itself unavailable. */
export class StrategyUnavailableError extends Error {
  override readonly name = "StrategyUnavailableError";
}
