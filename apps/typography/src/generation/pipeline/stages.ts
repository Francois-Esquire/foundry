/**
 * The stages after Generate as plain functions. The runner calls them in
 * order; a screen or a script can call any one of them alone. Normalise has
 * no function here: it is `normaliseSheet`, which the runner calls itself.
 */
import type { FaceId } from "~/typeface/face";
import type { NewCandidate, Verdict } from "~/typeface/project";
import type { Provenance } from "~/typeface/provenance";
import type { GlyphShape } from "~/typeface/reading";
import type { GlyphDraft } from "../draft";
import { evaluateGlyph } from "../evaluation/evaluate";
import type { Correction, Evaluation } from "../evaluation/evaluation";
import type { SheetExtraction } from "../extraction/extraction";
import {
  type ExtractionOptions,
  extractRasterSheet,
} from "../extraction/raster-sheet";
import { extractSvgSheet } from "../extraction/svg-sheet";
import type { HeightModel } from "../normalise/height-model";
import type { GlyphTarget } from "../plan/target";
import type { ImageCodec } from "../raster/image-codec";
import { refineGlyph } from "../refinement/refine";
import type {
  ProducedGlyph,
  RawOutput,
  StrategyOutput,
} from "../strategies/strategy";
import type { StyleReference } from "../style/reference";

export class MissingDecoderError extends Error {
  override readonly name = "MissingDecoderError";
}

/** What the later stages need to know about the glyphs being made. */
export interface GlyphContext {
  readonly heightModel: HeightModel;
  /** The face's own glyphs for targets under a holdout test, by target key. */
  readonly holdouts?: ReadonlyMap<string, GlyphShape>;
  readonly style: StyleReference;
  readonly targets: readonly GlyphTarget[];
}

/** Output a strategy drew as a sheet, which glyphs have to be cut from. */
type SheetOutput = Exclude<RawOutput, { readonly kind: "outlines" }>;

/** Extract: one item per glyph from a sheet. */
export const extractStage = async (
  raw: SheetOutput,
  codec: Pick<ImageCodec, "decode"> | undefined,
  options: ExtractionOptions = {}
): Promise<SheetExtraction> => {
  if (raw.kind === "sheet-svg") {
    return extractSvgSheet(raw.svg, raw.layout, options);
  }
  if (!codec) {
    throw new MissingDecoderError(
      "A raster sheet needs an image decoder, and none was given."
    );
  }
  return extractRasterSheet(await codec.decode(raw.image), raw.layout, options);
};

/** Outlines a strategy drew straight into font units, as drafts. Nothing is extracted or fitted. */
export const outlineDrafts = (glyphs: readonly ProducedGlyph[]): GlyphDraft[] =>
  glyphs.map(({ advance, key, outline, rule, weaknesses }) => ({
    advance,
    key,
    madeBy: rule,
    outline,
    weaknesses,
  }));

const contextFor = (draft: GlyphDraft, context: GlyphContext) => {
  const target = context.targets.find((item) => item.key === draft.key);
  return {
    holdout: context.holdouts?.get(draft.key),
    style: context.style,
    zone: target && context.heightModel(target),
  };
};

/** A draft with what evaluation says of it. */
export interface Evaluated {
  readonly draft: GlyphDraft;
  readonly evaluation: Evaluation;
}

const evaluated = (draft: GlyphDraft, context: GlyphContext): Evaluated => ({
  draft,
  evaluation: evaluateGlyph(draft, contextFor(draft, context)),
});

/** Validate: every draft with its evaluation. */
export const validateStage = (
  drafts: readonly GlyphDraft[],
  context: GlyphContext
): Evaluated[] => drafts.map((draft) => evaluated(draft, context));

export interface Refined {
  /** The corrections applied to each draft, by target key. */
  readonly corrections: ReadonlyMap<string, readonly Correction[]>;
  /** The drafts after correction, each with its evaluation after correction. */
  readonly glyphs: readonly Evaluated[];
}

/** Refine: applies the automatic corrections and evaluates what they changed again. */
export const refineStage = (
  validated: readonly Evaluated[],
  context: GlyphContext
): Refined => {
  const corrections = new Map<string, readonly Correction[]>();
  const glyphs = validated.map((glyph) => {
    if (glyph.evaluation.verdict === "fail") {
      return glyph;
    }
    const { applied, draft } = refineGlyph(
      glyph.draft,
      glyph.evaluation,
      contextFor(glyph.draft, context)
    );
    corrections.set(glyph.draft.key, applied);
    return applied.length > 0
      ? evaluated(draft, context)
      : { draft, evaluation: glyph.evaluation };
  });
  return { corrections, glyphs };
};

/**
 * The provenance of everything a strategy output leads to. Replayed output
 * keeps the strategy, model, run and time of the real call, marked recorded.
 */
export const provenanceOf = (
  output: StrategyOutput,
  runId: string
): Provenance => ({
  createdAt: output.createdAt,
  origin: "generated",
  runId: output.runId ?? runId,
  strategy: output.producedBy,
  ...(output.usage.model === undefined ? {} : { model: output.usage.model }),
  ...(output.recorded ? { recorded: true } : {}),
});

/** A candidate the project can propose, with the verdict its evaluation came to. */
export type JudgedCandidate = NewCandidate & { readonly verdict: Verdict };

/** Integrate: one candidate for each usable draft. */
export const integrateStage = (
  usable: readonly Evaluated[],
  targets: readonly GlyphTarget[],
  faceId: FaceId,
  provenance: Provenance,
  candidateId: (key: string) => string
): JudgedCandidate[] =>
  usable.flatMap(({ draft, evaluation }) => {
    const target = targets.find((item) => item.key === draft.key);
    return target
      ? [
          {
            advance: draft.advance,
            characters: target.characters,
            faceId,
            id: candidateId(draft.key),
            name: target.name,
            outline: draft.outline,
            provenance,
            replaces: target.replaces,
            verdict: evaluation.verdict,
          },
        ]
      : [];
  });
