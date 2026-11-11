/**
 * The Reconstruct place's one door to the reconstruction core. Everything the
 * place uses from `src/reconstruction` passes through this file, so a name
 * that moves there costs one edit here.
 */
import type { ImageCodec } from "~/generation/raster/image-codec";
import type { GenerationStrategy } from "~/generation/strategies/strategy";
import {
  type Evidence as CoreEvidence,
  importEvidence,
  mediaTypeFor,
} from "~/reconstruction/evidence/evidence";
import {
  type RegionView as CoreRegionView,
  viewRegion,
} from "~/reconstruction/evidence/rectify";
import {
  type Corners as CoreCorners,
  type EvidenceRegion as CoreEvidenceRegion,
  cornersOf,
  quadrilateralRegion,
  rectangleRegion,
} from "~/reconstruction/evidence/region";
import {
  type Inference as CoreInference,
  fitWidthToObserved,
  inferMissing,
} from "~/reconstruction/inference/infer";
import {
  type Isolation as CoreIsolation,
  isolateLettering,
  twoLevel,
} from "~/reconstruction/isolation/isolate";
import {
  type FaceMatch as CoreFaceMatch,
  type ReferenceFace as CoreReferenceFace,
  createFaceRecognizer,
} from "~/reconstruction/recognition/face-recognizer";
import {
  type Reading as CoreReading,
  readLettering,
  relabel,
} from "~/reconstruction/recognition/recognizer";
import { outlineOnEvidence } from "~/reconstruction/recovery/correspondence";
import {
  type RecoveredLetter as CoreRecoveredLetter,
  type RecoveryMetrics as CoreRecoveryMetrics,
  DEFAULT_METRICS,
  distinctLetters,
  recoverLetters,
} from "~/reconstruction/recovery/recover";
import type { FaceId } from "~/typeface/face";
import type { Outline, Point } from "~/typeface/outline";
import type { OpenFace } from "~/typeface/reading";

/** The core's own types, under the names this place uses for them. */
export type Corners = CoreCorners;
export type Evidence = CoreEvidence;
export type EvidenceRegion = CoreEvidenceRegion;
export type FaceMatch = CoreFaceMatch;
export type Inference = CoreInference;
type Isolation = CoreIsolation;
export type Reading = CoreReading;
export type RecoveredLetter = CoreRecoveredLetter;
export type RecoveryMetrics = CoreRecoveryMetrics;
export type ReferenceFace = CoreReferenceFace;
type RegionView = CoreRegionView;

export type SeparationMethod = Isolation["separation"]["by"];
export type LetteringPolarity = Isolation["separation"]["lettering"];

export const STANDARD_METRICS: RecoveryMetrics = DEFAULT_METRICS;

export const rectangle = rectangleRegion;
export const quadrilateral = quadrilateralRegion;
export const regionCorners = cornersOf;

/** Reads a picture file as evidence. The file's bytes are copied, never written. */
export const readEvidence = (
  file: { readonly bytes: Uint8Array; readonly fileName: string },
  codec: Pick<ImageCodec, "decode">
): Promise<Evidence> =>
  importEvidence({ ...file, mediaType: mediaTypeFor(file.fileName) }, codec);

export interface SightOptions {
  readonly by: SeparationMethod;
  /** Read from the picture when absent. */
  readonly lettering?: LetteringPolarity;
  readonly ruledLines: boolean;
  /** View pixels made from one evidence pixel. */
  readonly scale: number;
}

/** A region seen upright, with its lettering isolated. */
export interface Sighting {
  readonly isolation: Isolation;
  readonly view: RegionView;
}

export const sight = (
  evidence: Evidence,
  region: EvidenceRegion,
  options: SightOptions
): Sighting => {
  const view = viewRegion(evidence.pixels, region, { scale: options.scale });
  return {
    isolation: isolateLettering(view.image, {
      by: options.by,
      lettering: options.lettering,
      ruledLines: options.ruledLines,
    }),
    view,
  };
};

/** The isolated lettering as a clean two-level ink map, for showing. */
export const isolatedInk = (sighting: Sighting) =>
  twoLevel(sighting.isolation.ink);

/** Reads letters against reference faces, and ranks those faces by resemblance. */
export interface LetterReader {
  nearest(sighting: Sighting, readings: readonly Reading[]): FaceMatch[];
  read(sighting: Sighting): Reading[];
}

/** Every letter found, unread: what there is when no face is at hand to read against. */
const unread = ({ isolation }: Sighting): Reading[] =>
  isolation.lines.flatMap((line, lineIndex) =>
    line.letters.map(
      (letter, index): Reading => ({
        guesses: [],
        index,
        labelledBy: "recognizer",
        letter,
        line: lineIndex,
      })
    )
  );

export const letterReader = (
  references: readonly ReferenceFace[],
  characters: readonly number[]
): LetterReader => {
  if (references.length === 0) {
    return { nearest: () => [], read: unread };
  }
  const recognizer = createFaceRecognizer(references, characters);
  return {
    nearest: ({ isolation }, readings) =>
      recognizer.nearestFaces(isolation.lines, readings),
    read: ({ isolation }) => readLettering(isolation.lines, recognizer),
  };
};

/** A person's label over a reading, or none: a shape with no label is left out of recovery. */
export const labelReading = (
  reading: Reading,
  character: number | undefined
): Reading =>
  character === undefined
    ? { ...reading, character: undefined, labelledBy: "person" }
    : relabel(reading, character);

/** The face the recovered letters are meant for. */
export interface Target {
  /** The opened face. With it, names are checked and existing glyphs are redrawn. */
  readonly face?: OpenFace;
  readonly faceId: FaceId;
  readonly metrics: RecoveryMetrics;
}

export interface Recovery {
  /** One letter for each distinct character: what is proposed. */
  readonly distinct: readonly RecoveredLetter[];
  /** Every labelled letter, traced. */
  readonly recovered: readonly RecoveredLetter[];
}

export const recover = (
  evidence: Evidence,
  { isolation, view }: Sighting,
  readings: readonly Reading[],
  target: Target
): Recovery => {
  const recovered = recoverLetters({
    evidenceId: evidence.id,
    lines: isolation.lines,
    metrics: target.metrics,
    readings,
    target: { face: target.face, faceId: target.faceId },
    view,
  });
  return { distinct: distinctLetters(recovered, isolation.lines), recovered };
};

/** A recovered outline as it lies on the photograph, in evidence pixels with y down. */
export const outlineOnPhotograph = (letter: RecoveredLetter): Outline =>
  outlineOnEvidence(letter.candidate.outline, letter.correspondence);

/** The four corners of a found letter's box on the photograph, in evidence pixels. */
export const letterOnPhotograph = (
  { view }: Sighting,
  { letter }: Reading
): Point[] => {
  const { bottom, left, right, top } = letter.box;
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ].map(view.toEvidence);
};

export interface CompletionRequest {
  /** Says when the run started and ended. */
  readonly clock: () => Date;
  readonly codec: Pick<ImageCodec, "decode">;
  readonly evidence: Evidence;
  /** Makes the run's id, which its candidates' ids begin with. */
  readonly newId: () => string;
  readonly observed: readonly RecoveredLetter[];
  readonly signal?: AbortSignal;
  readonly strategy: GenerationStrategy;
  readonly target: Target;
  readonly wanted: readonly number[];
  readonly widthReference?: ReferenceFace;
}

/** Asks a generation strategy for the characters the evidence does not show. All inferred. */
export const inferCharacters = (
  request: CompletionRequest
): Promise<Inference> =>
  inferMissing({
    clock: request.clock,
    codec: request.codec,
    evidenceId: request.evidence.id,
    metrics: request.target.metrics,
    newId: request.newId,
    observed: request.observed,
    signal: request.signal,
    strategy: request.strategy,
    target: { face: request.target.face, faceId: request.target.faceId },
    wanted: request.wanted,
    widthReference: request.widthReference,
  });

export const narrowToObserved = fitWidthToObserved;
