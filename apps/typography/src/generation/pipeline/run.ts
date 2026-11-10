/**
 * The pipeline runner: Generate, Extract, Normalise, Compose, Validate,
 * Refine, Integrate. Analyse and Plan happen before a run, since their
 * results (the style reference and the targets) are what a run is asked with.
 */
import type { AxisLocation, FaceId } from "~/typeface/face";
import type { GlyphShape, OpenFace } from "~/typeface/reading";
import { type Composer, composeIndependently } from "../compose/compose";
import type { GlyphDraft } from "../draft";
import type { Correction, Evaluation } from "../evaluation/evaluation";
import type { SheetExtraction } from "../extraction/extraction";
import { type HeightModel, latinHeightModel } from "../normalise/height-model";
import type { SheetFit } from "../normalise/normalise";
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
  extractStage,
  type GlyphContext,
  integrateStage,
  type NewCandidate,
  normaliseStage,
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
  readonly clock?: () => Date;
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
  /** Makes run and candidate ids. Random UUIDs when absent. */
  readonly newId?: () => string;
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
  readonly candidates: readonly NewCandidate[];
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
    this.#clock = request.clock ?? (() => new Date());
    this.#report = request.onProgress ?? (() => undefined);
  }

  now() {
    return this.#clock();
  }

  async run<T>(
    stage: StageName,
    work: () => Promise<T> | T,
    describe: (result: T) => string
  ): Promise<T> {
    const started = this.now().getTime();
    this.#report({ stage, status: "started" });
    const result = await work();
    const elapsedMs = this.now().getTime() - started;
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

const count = (amount: number, noun: string) =>
  `${amount} ${noun}${amount === 1 ? "" : "s"}`;

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
 * Runs one generation. An unavailable strategy throws
 * `StrategyUnavailableError` with its reason: no other strategy is tried.
 */
export const runGeneration = async (
  request: GenerationRequest
): Promise<GenerationRun> => {
  const log = new StageLog(request);
  const newId = request.newId ?? (() => crypto.randomUUID());
  const attempt = newId();
  const startedAt = log.now().toISOString();
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
  const direct = output.raw.kind === "outlines";
  let extraction: SheetExtraction | undefined;
  if (direct) {
    log.skip("extract", "The strategy returned outlines, not a sheet.");
    log.skip("normalise", "The outlines are already in font units.");
  } else {
    extraction = await log.run(
      "extract",
      () =>
        extractStage(output.raw, request.codec, {
          vectorizer: request.vectorizer,
        }),
      (result) =>
        `${count(result?.glyphs.length ?? 0, "glyph")} found, ${count(result?.report.empty.length ?? 0, "empty cell")}.`
    );
  }
  const found = extraction;
  const normalised = direct
    ? normaliseStage(output.raw, undefined, context)
    : await log.run(
        "normalise",
        () => normaliseStage(output.raw, found, context),
        (result) =>
          `${count(result.drafts.length, "glyph")} fitted at ${result.fit?.unitsPerPixel.toFixed(2) ?? "?"} units per pixel.`
      );
  const composition = await log.run(
    "compose",
    () =>
      (request.composer ?? composeIndependently)(normalised.drafts, {
        face: request.face,
        targets: request.targets,
      }),
    (result) =>
      result.featureCode.length > 0
        ? `${count(result.featureCode.length, "layout rule")} written.`
        : "Glyphs left independent."
  );
  const firstEvaluations = await log.run(
    "validate",
    () => validateStage(composition.drafts, context),
    (result) =>
      `${count(result.filter((item) => item.defects.length > 0).length, "glyph")} with defects.`
  );
  const refined = await log.run(
    "refine",
    () => refineStage(composition.drafts, firstEvaluations, context),
    (result) =>
      `${count([...result.corrections.values()].flat().length, "correction")} applied.`
  );
  const usable = refined.drafts.filter(
    (_, index) => refined.evaluations[index]?.verdict !== "fail"
  );
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
  const rejected = refined.evaluations.filter(
    (evaluation) => evaluation.verdict === "fail"
  );
  return {
    artefacts: {
      corrections: refined.corrections,
      drafts: composition.drafts,
      extraction,
      featureCode: composition.featureCode,
      firstEvaluations,
      fit: normalised.fit,
      raw: output.raw,
      refined: refined.drafts,
      sent: output.sent,
    },
    candidates,
    evaluations: new Map(
      refined.evaluations
        .filter((evaluation) => evaluation.verdict !== "fail")
        .map((evaluation) => [candidateId(evaluation.key), evaluation])
    ),
    record: {
      costUsd: output.usage.costUsd,
      createdAt: output.createdAt,
      finishedAt: log.now().toISOString(),
      model: output.usage.model,
      modelLatencyMs: output.usage.latencyMs,
      notes: [...(extraction?.report.notes ?? []), ...composition.notes],
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
      unmade: unmadeBy(request, output, extraction, rejected),
    },
    rejected,
  };
};
