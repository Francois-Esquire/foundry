/**
 * Generating candidates for one face, as four operations: preparing a run
 * from a request, performing it, keeping what a model returned for it, and
 * proposing what it made. The Generate place's session and the generate
 * command call them in that order. None of them remembers anything: each
 * takes what it needs and answers with data, or refuses with the sentence a
 * person reads.
 */
import type {
  Correction,
  Evaluation,
} from "~/generation/evaluation/evaluation";
import { keepRunOutput, type OutputMeans } from "~/generation/model-output";
import {
  type GenerationRun,
  type RunRecord,
  runGeneration,
  type StageProgress,
} from "~/generation/pipeline/run";
import type { JudgedCandidate } from "~/generation/pipeline/stages";
import type { GlyphTarget } from "~/generation/plan/target";
import type { ImageCodec } from "~/generation/raster/image-codec";
import {
  loadRecorded,
  type RecordedEntry,
} from "~/generation/strategies/recorded/catalogue";
import { recordedTargets } from "~/generation/strategies/recorded/manifest";
import { recordedRunStrategy } from "~/generation/strategies/recorded/recorded-run";
import type { GenerationStrategy } from "~/generation/strategies/strategy";
import type { StyleReference } from "~/generation/style/reference";
import { Refusal } from "~/lib/refusal";
import type { GlyphRef } from "~/typeface/changes";
import type { FaceId } from "~/typeface/face";
import { candidateStatuses, type NewCandidate } from "~/typeface/project";
import type { GlyphShape, OpenFace } from "~/typeface/reading";
import type { Workspace } from "~/workspace/workspace";
import { planRequest } from "./request-plan";
import { type LiveStrategyKind, liveStrategy } from "./strategies";

/** What a run is asked for: characters drawn now, or a recorded run replayed. */
export type RunRequest =
  | {
      readonly kind: "characters";
      readonly characters: readonly number[];
      readonly faceId: FaceId;
      readonly strategy: LiveStrategyKind;
    }
  | {
      readonly kind: "recorded";
      /** The id of an entry of the recorded catalogue. */
      readonly entryId: string;
      readonly faceId: FaceId;
    };

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

/** What a run will make, and with what. */
export interface Prepared {
  /** The face as generation may see it: without the characters under test. */
  readonly face: OpenFace;
  readonly faceId: FaceId;
  /** The face's own glyphs the results are compared with, by target key. */
  readonly holdouts: ReadonlyMap<string, GlyphShape>;
  /** How many targets are parts another target is built from, not asked for themselves. */
  readonly parts: number;
  /** The recorded run that is replayed, when one is. */
  readonly recorded?: RecordedEntry;
  readonly strategy: GenerationStrategy;
  readonly targets: readonly GlyphTarget[];
}

/** One candidate of a run with everything the pipeline found out about it. */
export interface ReviewedCandidate {
  /** 1 for the run's own candidate, one more for each regeneration of the target. */
  readonly attempt: number;
  readonly candidate: JudgedCandidate;
  /** The automatic corrections refinement applied. */
  readonly corrections: readonly Correction[];
  readonly evaluation: Evaluation;
  /** The evaluation before refinement. */
  readonly first?: Evaluation;
  /** The face's own glyph, when the candidate was made under a holdout test. */
  readonly holdout?: GlyphShape;
  /** The record of the run or regeneration that made this candidate. */
  readonly record: RunRecord;
  readonly target: GlyphTarget;
}

/**
 * A character the project has already added a glyph for is redrawn, so
 * accepting the result replaces that glyph instead of colliding with it.
 */
const redrawAdded = (
  targets: readonly GlyphTarget[],
  glyphFor: (character: number) => GlyphRef | undefined
): GlyphTarget[] =>
  targets.map((target) => {
    const [character] = target.characters;
    const existing =
      target.replaces || character === undefined
        ? undefined
        : glyphFor(character);
    return existing?.kind === "added"
      ? { ...target, replaces: existing }
      : target;
  });

const prepareCharacters = (
  request: RunRequest & { readonly kind: "characters" },
  { clock, codec, modelFetch, providerKey, workspace }: RunMeans
): Prepared => {
  const plan = planRequest(
    workspace.openFace(request.faceId),
    request.characters,
    (character) => workspace.glyphForCharacter(request.faceId, character)
  );
  if (plan.targets.length === 0) {
    throw new Refusal(
      "No characters were asked for. Choose what to generate, then run again."
    );
  }
  const asked = new Set(request.characters);
  return {
    face: plan.face,
    faceId: request.faceId,
    holdouts: plan.holdouts,
    parts: plan.targets.filter(
      ({ characters: [character] }) =>
        character === undefined || !asked.has(character)
    ).length,
    strategy: liveStrategy(
      request.strategy,
      { clock, codec, fetch: modelFetch, providerKey: providerKey() },
      plan.heldOut
    ),
    targets: plan.targets,
  };
};

const prepareRecorded = async (
  request: RunRequest & { readonly kind: "recorded" },
  entries: readonly RecordedEntry[],
  { runs, workspace }: RunMeans
): Promise<Prepared> => {
  const entry = entries.find((listed) => listed.id === request.entryId);
  if (!entry) {
    throw new Refusal(
      "No recorded run is chosen. Choose one from the list, then run again."
    );
  }
  const face = workspace.openFace(request.faceId);
  const recorded = await loadRecorded(runs, entry);
  const targets = redrawAdded(recordedTargets(recorded, face), (character) =>
    workspace.glyphForCharacter(request.faceId, character)
  );
  // The face's own glyph is the answer only to a question that was asked
  // about this face. A run made from another font gets no comparison.
  const sameFace = entry.madeFrom?.family === face.description.familyName;
  const holdouts = new Map<string, GlyphShape>();
  for (const target of sameFace ? targets : []) {
    if (target.replaces?.kind === "source") {
      holdouts.set(target.key, face.glyph(target.replaces.glyphId));
    }
  }
  return {
    face,
    faceId: request.faceId,
    holdouts,
    parts: 0,
    recorded: entry,
    strategy: recordedRunStrategy(recorded),
    targets,
  };
};

/**
 * Plan: what a request will make, which of it is held out and compared with
 * the face's own glyphs, and the strategy that will draw it. `entries` are
 * the recorded runs a request may name. Refuses when no character was asked
 * for, or the recorded run named is not among the entries.
 */
export const prepareRun = (
  request: RunRequest,
  entries: readonly RecordedEntry[],
  means: RunMeans
): Promise<Prepared> =>
  request.kind === "recorded"
    ? prepareRecorded(request, entries, means)
    : Promise.resolve(prepareCharacters(request, means));

/**
 * Runs the pipeline on what was prepared, drawing in the style measured
 * from the face's source font. It changes nothing in the project. A
 * strategy that cannot run refuses here, at Generate, with its own reason.
 */
export const performRun = (
  prepared: Prepared,
  style: StyleReference,
  { clock, codec, newId }: Pick<RunMeans, "clock" | "codec" | "newId">,
  watch: {
    readonly onProgress?: (progress: StageProgress) => void;
    readonly signal?: AbortSignal;
  } = {}
): Promise<GenerationRun> =>
  runGeneration({
    clock,
    codec,
    face: prepared.face,
    faceId: prepared.faceId,
    holdouts: prepared.holdouts,
    newId,
    onProgress: watch.onProgress,
    signal: watch.signal,
    strategy: prepared.strategy,
    style,
    targets: prepared.targets,
  });

/**
 * Keeps what a model returned for a run, and answers with its artifact: the
 * recorded run that was replayed, or what came back from a model just now.
 * Nothing, for a run made by rule. It comes before proposing, so a run that
 * stops here has put nothing in the project.
 */
export const keepOutput = (
  { recorded, targets }: Pick<Prepared, "recorded" | "targets">,
  run: GenerationRun,
  means: OutputMeans
): Promise<string | undefined> =>
  keepRunOutput(recorded ? { recorded } : { run, targets }, means);

const reviewed = (
  { artefacts, candidates, evaluations, record }: GenerationRun,
  prepared: Prepared,
  attempt: number
): ReviewedCandidate[] =>
  candidates.flatMap((candidate): ReviewedCandidate[] => {
    const evaluation = evaluations.get(candidate.id);
    const target = prepared.targets.find(
      (planned) => planned.key === evaluation?.key
    );
    return evaluation && target
      ? [
          {
            attempt,
            candidate,
            corrections: artefacts.corrections.get(target.key) ?? [],
            evaluation,
            first: artefacts.firstEvaluations.find(
              (before) => before.key === target.key
            ),
            holdout: prepared.holdouts.get(target.key),
            record,
            target,
          },
        ]
      : [];
  });

const propose = (
  workspace: Pick<Workspace, "propose">,
  candidates: readonly NewCandidate[]
) => {
  const proposed = workspace.propose(candidates);
  if (!proposed.ok) {
    throw new Refusal(proposed.notice.message);
  }
};

/**
 * Integrate: proposes a run's candidates to the project and answers with
 * each beside what the pipeline found out about it. Refuses with the
 * project's reason, and then nothing was proposed.
 */
export const proposeRun = (
  workspace: Pick<Workspace, "propose">,
  prepared: Prepared,
  run: GenerationRun
): ReviewedCandidate[] => {
  propose(workspace, run.candidates);
  return reviewed(run, prepared, 1);
};

/**
 * Puts a target's regenerated candidate in the place of the one before it.
 * The new candidate goes to the project first: if the project refuses it,
 * the earlier one still stands and nothing was lost.
 */
export const proposeAgain = (
  workspace: Pick<Workspace, "getState" | "propose" | "rejectCandidate">,
  prepared: Prepared,
  run: GenerationRun,
  previous: ReviewedCandidate
): ReviewedCandidate => {
  const { key, name } = previous.target;
  const made = reviewed(run, prepared, previous.attempt + 1).find(
    (again) => again.target.key === key
  );
  if (!made) {
    const unmade = run.record.unmade.find((item) => item.key === key);
    throw new Refusal(
      `No candidate was made for ${name}. ${unmade?.reason ?? ""}`.trim()
    );
  }
  propose(workspace, [made.candidate]);
  const standing = candidateStatuses(workspace.getState().project).get(
    previous.candidate.id
  );
  if (standing === "proposed") {
    workspace.rejectCandidate(previous.candidate.id);
  }
  return made;
};
