/**
 * The pipeline runner: Generate, Extract, Normalise, Compose, Validate,
 * Refine, Integrate. Analyse and Plan happen before a run, since their
 * results (the style reference and the targets) are what a run is asked with.
 */

import { count } from "~/lib/count";
import type { AxisLocation, FaceId } from "~/typeface/face";
import type { GlyphShape, OpenFace } from "~/typeface/reading";
import { type Composer, composeIndependently } from "../compose/compose";
import type { GlyphDraft } from "../draft";
import type { Correction, Evaluation } from "../evaluation/evaluation";
import type { SheetExtraction } from "../extraction/extraction";
import { type HeightModel, latinHeightModel } from "../normalise/height-model";
import { normaliseSheet, type SheetFit } from "../normalise/normalise";
import type { GlyphTarget } from "../plan/target";
import type { ImageCodec } from "../raster/image-codec";
import {
  type GenerationStrategy,
  type ModelRequest,
  type RawOutput,
  type StrategyKind,
  type StrategyOutput,
  StrategyUnavailableError,
} from "../strategies/strategy";
import type { StyleReference } from "../style/reference";
import type { Vectorizer } from "../vector/vectorizer";
import {
  type Evaluated,
  extractStage,
  type GlyphContext,
  integrateStage,
  type JudgedCandidate,
  outlineDrafts,
  provenanceOf,
  refineStage,
  validateStage,
} from "./stages";

export const RUN_STAGES = [
  "generate",
  "extract",
  "normalise",
  "compose",
  "validate",
  "refine",
  "integrate",
] as const;

export type StageName = (typeof RUN_STAGES)[number];

export interface StageProgress {
  /** What the stage did, or why it was skipped. */
  readonly detail?: string;
  readonly elapsedMs?: number;
  readonly stage: StageName;
  readonly status: "finished" | "skipped" | "started";
}

export interface GenerationRequest {
  /** Says when the run started and ended, and times its stages. */
  readonly clock: () => Date;
  /** Decodes a raster sheet. Needed only by strategies that return pictures. */
  readonly codec?: Pick<ImageCodec, "decode">;
  readonly composer?: Composer;
  readonly face: OpenFace;
  readonly faceId: FaceId;
  /** The Latin model when absent. Pass a script's own model for anything else. */
  readonly heightModel?: HeightModel;
  /** The face's own glyphs for targets under a holdout test, by target key. */
  readonly holdouts?: ReadonlyMap<string, GlyphShape>;
  readonly location?: AxisLocation;
  /** Makes run and candidate ids. */
  readonly newId: () => string;
  readonly onProgress?: (progress: StageProgress) => void;
  readonly signal?: AbortSignal;
  readonly strategy: GenerationStrategy;
  readonly style: StyleReference;
  readonly targets: readonly GlyphTarget[];
  readonly vectorizer?: Vectorizer;
}

interface StageRecord {
  readonly detail: string;
  readonly elapsedMs: number;
  readonly stage: StageName;
  readonly status: "finished" | "skipped";
}

export interface RunRecord {
  /** In US dollars, when the provider stated it. */
  readonly costUsd?: number;
  /** When the output was produced. For a recorded run, when the model was called. */
  readonly createdAt: string;
  readonly finishedAt: string;
  readonly model?: string;
  /** How long the model took, when known. For a recorded run, how long it took when it was called. */
  readonly modelLatencyMs?: number;
  readonly notes: readonly string[];
  /** The strategy named in provenance: for a replay, the one that was recorded. */
  readonly producedBy: string;
  readonly recorded: boolean;
  readonly runId: string;
  readonly stages: readonly StageRecord[];
  readonly startedAt: string;
  readonly strategy: {
    readonly id: string;
    readonly kind: StrategyKind;
    readonly name: string;
  };
  /** Targets no candidate was made for, each with the reason. */
  readonly unmade: readonly { readonly key: string; readonly reason: string }[];
}

/** Everything a run produced on the way, kept so each stage can be inspected. */
interface RunArtefacts {
  /** Automatic corrections applied to each draft, by target key. */
  readonly corrections: ReadonlyMap<string, readonly Correction[]>;
  /** Drafts as they came out of Compose, before refinement. */
  readonly drafts: readonly GlyphDraft[];
  /** Per-glyph ink and outlines cut from a sheet, with what could not be found. */
  readonly extraction?: SheetExtraction;
  /** Layout feature code from Compose, for the glyphs that need it. */
  readonly featureCode: readonly string[];
  readonly firstEvaluations: readonly Evaluation[];
  readonly fit?: SheetFit;
  readonly raw: RawOutput;
  /** Drafts after refinement. */
  readonly refined: readonly GlyphDraft[];
  readonly sent?: ModelRequest;
}

export interface GenerationRun {
  readonly artefacts: RunArtefacts;
  /** Ready for `propose`. Drafts that failed evaluation are left out. */
  readonly candidates: readonly JudgedCandidate[];
  /** The final evaluation of each candidate, by candidate id. */
  readonly evaluations: ReadonlyMap<string, Evaluation>;
  readonly record: RunRecord;
  /** Evaluations of drafts that could not become candidates. */
  readonly rejected: readonly Evaluation[];
}

/** Times stages with the request's clock and reports them as they pass. */
class StageLog {
  readonly records: StageRecord[] = [];
  readonly #clock: () => Date;
  readonly #report: (progress: StageProgress) => void;

  constructor(request: GenerationRequest) {
    this.#clock = request.clock;
    this.#report = request.onProgress ?? (() => undefined);
  }

  /** The time on the request's clock. */
  time() {
    return this.#clock();
  }

  async run<T>(
    stage: StageName,
    work: () => Promise<T> | T,
    describe: (result: T) => string
  ): Promise<T> {
    const started = this.time().getTime();
    this.#report({ stage, status: "started" });
    const result = await work();
    const elapsedMs = this.time().getTime() - started;
    const detail = describe(result);
    this.records.push({ detail, elapsedMs, stage, status: "finished" });
    this.#report({ detail, elapsedMs, stage, status: "finished" });
    return result;
  }

  skip(stage: StageName, detail: string) {
    this.records.push({ detail, elapsedMs: 0, stage, status: "skipped" });
    this.#report({ detail, stage, status: "skipped" });
  }
}

const generate = (request: GenerationRequest): Promise<StrategyOutput> => {
  const availability = request.strategy.availability();
  if (!availability.available) {
    throw new StrategyUnavailableError(availability.reason);
  }
  return request.strategy.generate({
    face: request.face,
    location: request.location,
    signal: request.signal,
    style: request.style,
    targets: request.targets,
  });
};

const unmadeBy = (
  request: GenerationRequest,
  output: StrategyOutput,
  extraction: SheetExtraction | undefined,
  rejected: readonly Evaluation[]
) => {
  const missing = new Map(output.unmade.map((item) => [item.key, item.reason]));
  for (const key of extraction?.report.empty ?? []) {
    missing.set(key, "Its cell on the sheet was empty.");
  }
  for (const key of extraction?.report.merged.flat() ?? []) {
    missing.set(key, "Its ink ran together with a neighbouring cell.");
  }
  for (const evaluation of rejected) {
    missing.set(
      evaluation.key,
      evaluation.defects.map((defect) => defect.detail).join(" ")
    );
  }
  return request.targets
    .filter((target) => missing.has(target.key))
    .map((target) => ({
      key: target.key,
      reason: missing.get(target.key) ?? "",
    }));
};

/**
 * The drafts a strategy's output leads to. Outlines are drafts already, so
 * nothing is extracted or fitted. A sheet is cut into glyphs and those are
 * fitted to font units, and what both stages found is kept for the record.
 */
const draftsOf = async (
  raw: RawOutput,
  request: GenerationRequest,
  context: GlyphContext,
  log: StageLog
): Promise<{
  readonly drafts: readonly GlyphDraft[];
  readonly extraction?: SheetExtraction;
  readonly fit?: SheetFit;
}> => {
  if (raw.kind === "outlines") {
    log.skip("extract", "The strategy returned outlines, not a sheet.");
    log.skip("normalise", "The outlines are already in font units.");
    return { drafts: outlineDrafts(raw.glyphs) };
  }
  const extraction = await log.run(
    "extract",
    () => extractStage(raw, request.codec, { vectorizer: request.vectorizer }),
    (result) =>
      `${count(result.glyphs.length, "glyph")} found, ${count(result.report.empty.length, "empty cell")}.`
  );
  const { drafts, fit } = await log.run(
    "normalise",
    () =>
      normaliseSheet(
        extraction,
        raw.layout,
        context.targets,
        context.style,
        context.heightModel
      ),
    (result) =>
      `${count(result.drafts.length, "glyph")} fitted at ${result.fit.unitsPerPixel.toFixed(2)} units per pixel.`
  );
  return { drafts, extraction, fit };
};

/**
 * Runs one generation. An unavailable strategy throws
 * `StrategyUnavailableError` with its reason: no other strategy is tried.
 */
export const runGeneration = async (
  request: GenerationRequest
): Promise<GenerationRun> => {
  const log = new StageLog(request);
  const attempt = request.newId();
  const startedAt = log.time().toISOString();
  const context: GlyphContext = {
    heightModel: request.heightModel ?? latinHeightModel(request.style),
    holdouts: request.holdouts,
    style: request.style,
    targets: request.targets,
  };
  const output = await log.run(
    "generate",
    () => generate(request),
    (result) =>
      `${request.strategy.name} returned ${result.raw.kind === "outlines" ? count(result.raw.glyphs.length, "outline") : "one sheet"}${result.recorded ? ", replayed from a recorded run" : ""}.`
  );
  const made = await draftsOf(output.raw, request, context, log);
  const composition = await log.run(
    "compose",
    () =>
      (request.composer ?? composeIndependently)(made.drafts, {
        face: request.face,
        targets: request.targets,
      }),
    (result) =>
      result.featureCode.length > 0
        ? `${count(result.featureCode.length, "layout rule")} written.`
        : "Glyphs left independent."
  );
  const validated = await log.run(
    "validate",
    () => validateStage(composition.drafts, context),
    (result) =>
      `${count(result.filter(({ evaluation }) => evaluation.defects.length > 0).length, "glyph")} with defects.`
  );
  const refined = await log.run(
    "refine",
    () => refineStage(validated, context),
    (result) =>
      `${count([...result.corrections.values()].flat().length, "correction")} applied.`
  );
  const failed = ({ evaluation }: Evaluated) => evaluation.verdict === "fail";
  const usable = refined.glyphs.filter((glyph) => !failed(glyph));
  const candidateId = (key: string) => `${attempt}:${key}`;
  const candidates = await log.run(
    "integrate",
    () =>
      integrateStage(
        usable,
        request.targets,
        request.faceId,
        provenanceOf(output, attempt),
        candidateId
      ),
    (result) => `${count(result.length, "candidate")} ready to propose.`
  );
  const rejected = refined.glyphs
    .filter(failed)
    .map(({ evaluation }) => evaluation);
  return {
    artefacts: {
      corrections: refined.corrections,
      drafts: composition.drafts,
      extraction: made.extraction,
      featureCode: composition.featureCode,
      firstEvaluations: validated.map(({ evaluation }) => evaluation),
      fit: made.fit,
      raw: output.raw,
      refined: refined.glyphs.map(({ draft }) => draft),
      sent: output.sent,
    },
    candidates,
    evaluations: new Map(
      usable.map(({ evaluation }) => [candidateId(evaluation.key), evaluation])
    ),
    record: {
      costUsd: output.usage.costUsd,
      createdAt: output.createdAt,
      finishedAt: log.time().toISOString(),
      model: output.usage.model,
      modelLatencyMs: output.usage.latencyMs,
      notes: [...(made.extraction?.report.notes ?? []), ...composition.notes],
      producedBy: output.producedBy,
      recorded: output.recorded,
      runId: output.runId ?? attempt,
      stages: log.records,
      startedAt,
      strategy: {
        id: request.strategy.id,
        kind: request.strategy.kind,
        name: request.strategy.name,
      },
      unmade: unmadeBy(request, output, made.extraction, rejected),
    },
    rejected,
  };
};
