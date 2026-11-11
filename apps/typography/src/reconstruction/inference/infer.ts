/**
 * Inferring what is missing: the characters the evidence does not show are
 * drawn by a generation strategy from the style of the letters it does show.
 * Everything that comes out is marked inferred. Nothing here draws a glyph
 * itself: the caller passes the strategy, and a recorded model run is one.
 */
import type { HeightModel } from "~/generation/normalise/height-model";
import { type GenerationRun, runGeneration } from "~/generation/pipeline/run";
import { planCharacters } from "~/generation/plan/plan";
import type { GlyphTarget } from "~/generation/plan/target";
import type { ImageCodec } from "~/generation/raster/image-codec";
import type { GenerationStrategy } from "~/generation/strategies/strategy";
import {
  analyseStyle,
  type StyleReference,
} from "~/generation/style/reference";
import {
  type ReferenceSheet,
  renderReferenceSheet,
} from "~/generation/style/reference-sheet";
import { roundOutline, transformOutline } from "~/typeface/outline";
import type { NewCandidate } from "~/typeface/project";
import type { GenerationSource, Provenance } from "~/typeface/provenance";
import type { OpenFace } from "~/typeface/reading";
import type { ReferenceFace } from "../recognition/face-recognizer";
import { namingFor, type TargetFace } from "../recovery/naming";
import type { RecoveredLetter, RecoveryMetrics } from "../recovery/recover";
import { observedFace } from "./observed-face";
import { compareWidths, type WidthComparison } from "./proportions";

export interface InferenceRequest {
  /** Says when the run started and ended. */
  readonly clock: () => Date;
  /** Decodes a sheet a strategy returns as a picture. */
  readonly codec?: Pick<ImageCodec, "decode">;
  readonly evidenceId: string;
  /** The Latin model when absent. Pass a script's own model for anything else. */
  readonly heightModel?: HeightModel;
  readonly metrics: RecoveryMetrics;
  /** Makes the run's id, which its candidates' ids begin with. */
  readonly newId: () => string;
  /** One recovered letter for each observed character. */
  readonly observed: readonly RecoveredLetter[];
  readonly signal?: AbortSignal;
  /** Any generation strategy: procedural, a model, or a recorded run. */
  readonly strategy: GenerationStrategy;
  readonly target: TargetFace;
  /** The characters wanted. Those already observed are left alone. */
  readonly wanted: readonly number[];
  /** A face that has both the observed and the wanted letters, to compare widths like with like. */
  readonly widthReference?: ReferenceFace;
}

export interface Inference {
  /** Wanted characters that were observed, so nothing was inferred for them. */
  readonly alreadyObserved: readonly number[];
  /** Ready for `propose`. Each has reconstructed, inferred provenance. */
  readonly candidates: readonly NewCandidate[];
  /** The observed letters as the face the strategy was given. */
  readonly observedFace: OpenFace;
  /** The sheet of observed letters the strategy was briefed with. */
  readonly referenceSheet: ReferenceSheet;
  /** The generation run behind the candidates, with its stages and evaluations. */
  readonly run: GenerationRun;
  /** The style measured from the observed outlines. */
  readonly style: StyleReference;
  /** How wide the inferred glyphs are beside the observed ones. */
  readonly widths: WidthComparison;
}

/** The run a generated design came from, to carry on a design inferred from it. */
const generationSourceOf = (
  provenance: Provenance
): GenerationSource | undefined => {
  if (provenance.origin !== "generated") {
    return;
  }
  const { origin: _origin, ...source } = provenance;
  return source;
};

/** Infers candidates for the wanted characters the evidence does not show. */
export const inferMissing = async (
  request: InferenceRequest
): Promise<Inference> => {
  const face = observedFace(
    request.observed.map(({ candidate, character }) => ({
      advance: candidate.advance,
      character,
      outline: candidate.outline,
    })),
    request.metrics
  );
  const style = analyseStyle(face);
  const referenceSheet = renderReferenceSheet(face, style, {
    characters: [...face.characters()],
  });
  const plan = planCharacters(face, request.wanted);
  // Names and redrawings are decided by the face the candidates are for, not
  // by the observed letters, which only stand in as the style to follow.
  const naming = namingFor(request.target);
  const targets = plan.targets.map((target): GlyphTarget => {
    const [character] = target.characters;
    return character === undefined
      ? target
      : { ...target, ...naming(character) };
  });
  const run = await runGeneration({
    clock: request.clock,
    codec: request.codec,
    face,
    faceId: request.target.faceId,
    heightModel: request.heightModel,
    newId: request.newId,
    signal: request.signal,
    strategy: request.strategy,
    style,
    targets,
  });
  const candidates = run.candidates.map(
    (candidate): NewCandidate => ({
      ...candidate,
      provenance: {
        basis: "inferred",
        evidenceId: request.evidenceId,
        inferredBy: generationSourceOf(candidate.provenance),
        origin: "reconstructed",
      },
    })
  );
  return {
    alreadyObserved: plan.present,
    candidates,
    observedFace: face,
    referenceSheet,
    run,
    style,
    widths: compareWidths(
      request.observed.map(({ candidate, character }) => ({
        character,
        outline: candidate.outline,
      })),
      candidates.flatMap((candidate) => {
        const [character] = candidate.characters;
        return character === undefined
          ? []
          : [{ character, outline: candidate.outline }];
      }),
      request.widthReference
    ),
  };
};

export interface WidthFit {
  readonly candidates: readonly NewCandidate[];
  /** What every outline and advance was multiplied by across. 1 when nothing was changed. */
  readonly factor: number;
}

/**
 * Brings inferred candidates to the width of the observed letters by one
 * stretch across, the same for all of them. It is a correction a person asks
 * for, never applied in passing: it also thins or thickens upright strokes
 * by the same factor, which is right when the strategy drew the same design
 * at another width and wrong when it drew another design.
 */
export const fitWidthToObserved = (inference: Inference): WidthFit => {
  const { ratio } = inference.widths;
  if (!(ratio > 0) || ratio === 1) {
    return { candidates: inference.candidates, factor: 1 };
  }
  const factor = 1 / ratio;
  return {
    candidates: inference.candidates.map((candidate) => ({
      ...candidate,
      advance: Math.round(candidate.advance * factor),
      outline: roundOutline(
        transformOutline(candidate.outline, {
          dx: 0,
          dy: 0,
          xx: factor,
          xy: 0,
          yx: 0,
          yy: 1,
        })
      ),
    })),
    factor,
  };
};
