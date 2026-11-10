/**
 * The stages after Generate as plain functions. The runner calls them in
 * order; a screen or a script can call any one of them alone.
 */
import type { FaceId } from "~/typeface/face";
import type { Candidate } from "~/typeface/project";
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
import { normaliseSheet, type SheetFit } from "../normalise/normalise";
import type { GlyphTarget } from "../plan/target";
import type { ImageCodec } from "../raster/image-codec";
import { refineGlyph } from "../refinement/refine";
import type { RawOutput, StrategyOutput } from "../strategies/strategy";
import type { StyleReference } from "../style/reference";

/** A proposed glyph before the project gives it a status. */
export type NewCandidate = Omit<Candidate, "status">;

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

/**
 * Extract: one item per glyph from a sheet. Output that is already outlines
 * has nothing to extract, and the answer is undefined.
 */
export const extractStage = async (
  raw: RawOutput,
  codec: Pick<ImageCodec, "decode"> | undefined,
  options: ExtractionOptions = {}
): Promise<SheetExtraction | undefined> => {
  if (raw.kind === "outlines") {
    return;
  }
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

/** Normalise: drafts in font units, from extracted shapes or straight from outlines. */
export const normaliseStage = (
  raw: RawOutput,
  extraction: SheetExtraction | undefined,
  context: GlyphContext
): { readonly drafts: readonly GlyphDraft[]; readonly fit?: SheetFit } => {
  if (raw.kind === "outlines") {
    return {
      drafts: raw.glyphs.map(({ advance, key, outline, rule, weaknesses }) => ({
        advance,
        key,
        madeBy: rule,
        outline,
        weaknesses,
      })),
    };
  }
  if (!extraction) {
    return { drafts: [] };
  }
  return normaliseSheet(
    extraction,
    raw.layout,
    context.targets,
    context.style,
    context.heightModel
  );
};

const contextFor = (draft: GlyphDraft, context: GlyphContext) => {
  const target = context.targets.find((item) => item.key === draft.key);
  return {
    holdout: context.holdouts?.get(draft.key),
    style: context.style,
    zone: target && context.heightModel(target),
  };
};

/** Validate: one evaluation per draft. */
export const validateStage = (
  drafts: readonly GlyphDraft[],
  context: GlyphContext
): Evaluation[] =>
  drafts.map((draft) => evaluateGlyph(draft, contextFor(draft, context)));

export interface Refined {
  /** The corrections applied to each draft, by target key. */
  readonly corrections: ReadonlyMap<string, readonly Correction[]>;
  readonly drafts: readonly GlyphDraft[];
  /** The evaluations of the drafts after correction. */
  readonly evaluations: readonly Evaluation[];
}

/** Refine: applies the automatic corrections and evaluates again. */
export const refineStage = (
  drafts: readonly GlyphDraft[],
  evaluations: readonly Evaluation[],
  context: GlyphContext
): Refined => {
  const corrections = new Map<string, readonly Correction[]>();
  const refined = drafts.map((draft, index) => {
    const evaluation = evaluations[index];
    if (!evaluation || evaluation.verdict === "fail") {
      return draft;
    }
    const result = refineGlyph(draft, evaluation, contextFor(draft, context));
    corrections.set(draft.key, result.applied);
    return result.draft;
  });
  return {
    corrections,
    drafts: refined,
    evaluations: refined.map((draft, index) =>
      (corrections.get(draft.key)?.length ?? 0) > 0
        ? evaluateGlyph(draft, contextFor(draft, context))
        : (evaluations[index] ??
          evaluateGlyph(draft, contextFor(draft, context)))
    ),
  };
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

/** Integrate: candidates the project can propose, one per usable draft. */
export const integrateStage = (
  drafts: readonly GlyphDraft[],
  targets: readonly GlyphTarget[],
  faceId: FaceId,
  provenance: Provenance,
  candidateId: (key: string) => string
): NewCandidate[] =>
  drafts.flatMap((draft) => {
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
          },
        ]
      : [];
  });
