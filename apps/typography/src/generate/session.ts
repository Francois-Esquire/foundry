/**
 * The Generate place's session: what it remembers while the app is open and
 * the runs it makes. Evaluations and run records are not part of the
 * project, and the screen is taken down whenever a person looks at another
 * place, so they live here. Candidates themselves go to the workspace, and
 * their status is always read from there.
 *
 * Everything is held in memory only, the provider key included.
 */
import type {
  Correction,
  Evaluation,
} from "~/generation/evaluation/evaluation";
import {
  type GenerationRun,
  type RunRecord,
  runGeneration,
} from "~/generation/pipeline/run";
import type { NewCandidate } from "~/generation/pipeline/stages";
import type { GlyphTarget } from "~/generation/plan/target";
import type { ImageCodec } from "~/generation/raster/image-codec";
import {
  type RecordedRun,
  recordedTargets,
} from "~/generation/strategies/recorded/manifest";
import { recordedRunStrategy } from "~/generation/strategies/recorded/recorded-run";
import type {
  GenerationStrategy,
  ModelRequest,
  RawOutput,
  StrategyKind,
} from "~/generation/strategies/strategy";
import {
  analyseStyle,
  type StyleReference,
} from "~/generation/style/reference";
import {
  type ReferenceSheet,
  renderReferenceSheet,
} from "~/generation/style/reference-sheet";
import type { GlyphRef } from "~/typeface/changes";
import type { FaceId } from "~/typeface/face";
import type { GlyphShape, OpenFace } from "~/typeface/reading";
import type { Workspace } from "~/workspace/workspace";
import { acceptCandidates } from "./accepting";
import { DEFAULT_SCOPE_KEY } from "./missing-characters";
import {
  type Fetch,
  listRecordedRuns,
  loadRecordedEntry,
  type RecordedCatalogue,
  type RecordedEntry,
} from "./recorded-catalogue";
import { planRequest } from "./request-plan";
import {
  emptyBoard,
  endStage,
  failBoard,
  followProgress,
  type StageBoard,
  type StageFailure,
  type StageId,
  type StageOutcome,
  startStage,
} from "./stage-board";
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
      readonly entryId: string;
      readonly faceId: FaceId;
    };

/** One candidate of a run with everything the pipeline found out about it. */
export interface ReviewedCandidate {
  /** 1 for the run's own candidate, one more for each regeneration of the target. */
  readonly attempt: number;
  readonly candidate: NewCandidate;
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

interface Regeneration {
  /** The target that was generated again. */
  readonly key: string;
  readonly outcomes: readonly StageOutcome[];
  readonly record: RunRecord;
}

export interface ReviewedRun {
  readonly candidates: readonly ReviewedCandidate[];
  readonly faceId: FaceId;
  /** Unique in the session. A replayed recording keeps its own run id in the record. */
  readonly id: string;
  /** Analyse and Plan, then the stages the pipeline ran. */
  readonly outcomes: readonly StageOutcome[];
  /** The raw output of the strategy, as it came back. */
  readonly raw: RawOutput;
  readonly record: RunRecord;
  /** The recorded run that was replayed, when one was. */
  readonly recorded?: RecordedEntry;
  readonly regenerations: readonly Regeneration[];
  readonly request: RunRequest;
  /** What a model was sent, when one was asked. */
  readonly sent?: ModelRequest;
  readonly targets: readonly GlyphTarget[];
}

export type TargetSource = "language" | "script" | "typed";

/** The choices on the screen, kept so they survive a visit to another place. */
export interface Draft {
  /** A BCP 47 tag, or empty before a language is chosen. */
  readonly language: string;
  /** The id of the recorded run to replay, or empty before one is chosen. */
  readonly recordedId: string;
  /** The value of the chosen writing system option. */
  readonly scope: string;
  readonly source: TargetSource;
  readonly strategy: StrategyKind;
  readonly typed: string;
}

export type CatalogueState =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "listed"; readonly catalogue: RecordedCatalogue };

/** The run under way, or the last one that ended. */
export interface Activity {
  readonly board: StageBoard;
  readonly failure?: StageFailure;
  readonly status: "failed" | "finished" | "running";
}

export interface GenerateState {
  readonly activity?: Activity;
  readonly catalogue: CatalogueState;
  readonly draft: Draft;
  /** In memory only. Never written to storage. */
  readonly providerKey: string;
  /** Finished runs, the newest first. */
  readonly runs: readonly ReviewedRun[];
  /** The run on the candidate board. */
  readonly shownRunId?: string;
}

/** What Analyse made of a face: the measurements and the sheet a model is shown. */
export interface StyleReading {
  readonly elapsedMs: number;
  readonly sheet: ReferenceSheet;
  readonly style: StyleReference;
}

export interface SessionMeans {
  /** Where the app is served from, ending in a slash. */
  readonly base: string;
  /** Says when a run started, ended and produced its output. The system clock when absent. */
  readonly clock?: () => Date;
  readonly codec: ImageCodec;
  /** Fetches the recorded runs served with the app. */
  readonly fetch: Fetch;
  /** Replaces the network for model calls in tests. */
  readonly modelFetch?: typeof fetch;
  readonly newId?: () => string;
  /** Milliseconds, for timing Analyse and Plan. */
  readonly now?: () => number;
  readonly workspace: Workspace;
}

export interface GenerateSession {
  /** Accepts every proposed candidate of a run whose evaluation passed. Returns how many. */
  acceptPassed(runId: string): number;
  getState(): GenerateState;
  /** Lists the recorded runs served with the app. Does nothing once they are listed. */
  listRecorded(): Promise<void>;
  /** Generates one target of a run again and puts the result in its place. */
  regenerate(runId: string, key: string): Promise<void>;
  /** Runs the pipeline and proposes its candidates. Never rejects: a failure is in the activity. */
  run(request: RunRequest): Promise<void>;
  setProviderKey(key: string): void;
  showRun(runId: string): void;
  /** Stops the run under way. */
  stop(): void;
  /**
   * Measures a face's source font, once, and keeps the result. The working
   * face is not measured: edits and accepted glyphs do not reach it.
   */
  styleOf(faceId: FaceId): StyleReading;
  subscribe(listener: () => void): () => void;
  updateDraft(patch: Partial<Draft>): void;
}

interface Prepared {
  readonly face: OpenFace;
  readonly holdouts: ReadonlyMap<string, GlyphShape>;
  /** What Plan decided, in a sentence. */
  readonly planned: string;
  readonly recorded?: RecordedEntry;
  readonly strategy: GenerationStrategy;
  readonly targets: readonly GlyphTarget[];
}

interface Performed {
  readonly outcomes: readonly StageOutcome[];
  readonly prepared: Prepared;
  readonly run: GenerationRun;
}

const count = (amount: number, noun: string) =>
  `${amount} ${noun}${amount === 1 ? "" : "s"}`;

const reasonOf = (error: unknown): string => {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "The run was stopped before it finished.";
  }
  return error instanceof Error ? error.message : String(error);
};

/** Lets the browser draw the stages so far before the next piece of work. */
const pause = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

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

const INITIAL_DRAFT: Draft = {
  language: "",
  recordedId: "",
  scope: DEFAULT_SCOPE_KEY,
  source: "typed",
  strategy: "procedural",
  typed: "",
};

export const createGenerateSession = (means: SessionMeans): GenerateSession => {
  const { workspace } = means;
  const now = means.now ?? (() => performance.now());
  const newId = means.newId ?? (() => crypto.randomUUID());
  const listeners = new Set<() => void>();
  const styles = new Map<FaceId, StyleReading>();
  const loadedRuns = new Map<string, RecordedRun>();
  let stopper: AbortController | undefined;
  let state: GenerateState = {
    catalogue: { status: "idle" },
    draft: INITIAL_DRAFT,
    providerKey: "",
    runs: [],
  };

  const setState = (patch: Partial<GenerateState>) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const styleOf = (faceId: FaceId): StyleReading => {
    const known = styles.get(faceId);
    if (known) {
      return known;
    }
    const face = workspace.openFace(faceId);
    const started = now();
    const style = analyseStyle(face);
    const reading: StyleReading = {
      elapsedMs: now() - started,
      sheet: renderReferenceSheet(face, style),
      style,
    };
    styles.set(faceId, reading);
    return reading;
  };

  const glyphFor = (faceId: FaceId) => (character: number) =>
    workspace.glyphForCharacter(faceId, character);

  const prepareCharacters = (
    request: RunRequest & { readonly kind: "characters" },
    face: OpenFace
  ): Prepared => {
    const plan = planRequest(
      face,
      request.characters,
      glyphFor(request.faceId)
    );
    if (plan.targets.length === 0) {
      throw new Error(
        "No characters were asked for. Choose what to generate, then run again."
      );
    }
    const asked = new Set(request.characters);
    const parts = plan.targets.filter(
      ({ characters: [character] }) =>
        character === undefined || !asked.has(character)
    ).length;
    return {
      face: plan.face,
      holdouts: plan.holdouts,
      planned: [
        `${count(plan.targets.length, "target")} planned`,
        parts > 0 ? `${count(parts, "part")} first` : "",
        plan.heldOut.length > 0
          ? `${plan.heldOut.length} under a holdout test`
          : "",
      ]
        .filter(Boolean)
        .join(", ")
        .concat("."),
      strategy: liveStrategy(
        request.strategy,
        {
          clock: means.clock,
          codec: means.codec,
          fetch: means.modelFetch,
          providerKey: state.providerKey,
        },
        plan.heldOut
      ),
      targets: plan.targets,
    };
  };

  const prepareRecorded = async (
    request: RunRequest & { readonly kind: "recorded" },
    face: OpenFace
  ): Promise<Prepared> => {
    const entry =
      state.catalogue.status === "listed"
        ? state.catalogue.catalogue.entries.find(
            (listed) => listed.id === request.entryId
          )
        : undefined;
    if (!entry) {
      throw new Error(
        "No recorded run is chosen. Choose one from the list, then run again."
      );
    }
    let recorded = loadedRuns.get(entry.id);
    if (!recorded) {
      recorded = await loadRecordedEntry(means.fetch, means.base, entry);
      loadedRuns.set(entry.id, recorded);
    }
    const targets = redrawAdded(
      recordedTargets(recorded, face),
      glyphFor(request.faceId)
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
      holdouts,
      planned: `The recorded run drew ${count(targets.length, "glyph")}. ${
        holdouts.size > 0
          ? `${holdouts.size} are compared with the face's own.`
          : "None is compared with the face's own."
      }`,
      recorded: entry,
      strategy: recordedRunStrategy(recorded),
      targets,
    };
  };

  const fail = (board: StageBoard, reason: string, stage?: StageId) => {
    const failed = failBoard(board, reason, stage);
    setState({
      activity: {
        board: failed.board,
        failure: failed.failure,
        status: "failed",
      },
    });
  };

  /** Analyse, Plan and the pipeline. On failure the activity says where and why. */
  const perform = async (
    request: RunRequest
  ): Promise<(Performed & { readonly board: StageBoard }) | undefined> => {
    stopper = new AbortController();
    let board = emptyBoard();
    const show = (next: StageBoard) => {
      board = next;
      setState({ activity: { board, status: "running" } });
    };
    show(startStage(board, "analyse"));
    try {
      const face = workspace.openFace(request.faceId);
      const reading = styleOf(request.faceId);
      const analysed: StageOutcome = {
        detail: `${count(reading.style.characters.length, "glyph")} of ${face.description.fullName} measured, in the source font as imported.`,
        elapsedMs: reading.elapsedMs,
        stage: "analyse",
        status: "finished",
      };
      show(startStage(endStage(board, analysed), "plan"));
      const started = now();
      const prepared =
        request.kind === "recorded"
          ? await prepareRecorded(request, face)
          : prepareCharacters(request, face);
      const planned: StageOutcome = {
        detail: prepared.planned,
        elapsedMs: now() - started,
        stage: "plan",
        status: "finished",
      };
      show(endStage(board, planned));
      await pause();
      const run = await runGeneration({
        clock: means.clock,
        codec: means.codec,
        face: prepared.face,
        faceId: request.faceId,
        holdouts: prepared.holdouts,
        newId,
        onProgress: (progress) => show(followProgress(board, progress)),
        signal: stopper.signal,
        strategy: prepared.strategy,
        style: reading.style,
        targets: prepared.targets,
      });
      return {
        board,
        outcomes: [analysed, planned, ...run.record.stages],
        prepared,
        run,
      };
    } catch (error) {
      fail(board, reasonOf(error));
    }
  };

  const isBusy = () => state.activity?.status === "running";

  const statusOf = (candidateId: string) =>
    workspace
      .getState()
      .project.candidates.find((candidate) => candidate.id === candidateId)
      ?.status;

  return {
    acceptPassed(runId) {
      const run = state.runs.find((known) => known.id === runId);
      const passed = (run?.candidates ?? [])
        .filter(
          ({ candidate, evaluation }) =>
            evaluation.verdict === "pass" &&
            statusOf(candidate.id) === "proposed"
        )
        .map(({ candidate }) => candidate.id);
      return acceptCandidates(workspace, passed).accepted;
    },
    getState: () => state,
    async listRecorded() {
      if (
        state.catalogue.status === "loading" ||
        state.catalogue.status === "listed"
      ) {
        return;
      }
      setState({ catalogue: { status: "loading" } });
      try {
        const catalogue = await listRecordedRuns(means.fetch, means.base);
        const [first] = catalogue.entries;
        setState({
          catalogue: { catalogue, status: "listed" },
          draft: {
            ...state.draft,
            recordedId: state.draft.recordedId || (first?.id ?? ""),
          },
        });
      } catch (error) {
        setState({
          catalogue: { reason: reasonOf(error), status: "failed" },
        });
      }
    },
    async regenerate(runId, key) {
      const run = state.runs.find((known) => known.id === runId);
      const previous = run?.candidates.find(
        (reviewedCandidate) => reviewedCandidate.target.key === key
      );
      if (isBusy() || !(run && previous)) {
        return;
      }
      const [character] = previous.target.characters;
      const request: RunRequest =
        run.request.kind === "characters" && character !== undefined
          ? { ...run.request, characters: [character] }
          : run.request;
      const performed = await perform(request);
      if (!performed) {
        return;
      }
      const [made] = reviewed(
        performed.run,
        performed.prepared,
        previous.attempt + 1
      ).filter((again) => again.target.key === key);
      if (!made) {
        const unmade = performed.run.record.unmade.find(
          (item) => item.key === key
        );
        fail(
          performed.board,
          `No candidate was made for ${previous.target.name}. ${unmade?.reason ?? ""}`.trim(),
          "integrate"
        );
        return;
      }
      // The new candidate first. If the project refuses it, the earlier one
      // still stands and nothing was lost.
      const proposed = workspace.propose([made.candidate]);
      if (!proposed.ok) {
        fail(performed.board, proposed.notice.message, "integrate");
        return;
      }
      if (statusOf(previous.candidate.id) === "proposed") {
        workspace.rejectCandidate(previous.candidate.id);
      }
      const regenerated: ReviewedRun = {
        ...run,
        candidates: run.candidates.map((existing) =>
          existing.target.key === key ? made : existing
        ),
        regenerations: [
          ...run.regenerations,
          { key, outcomes: performed.outcomes, record: performed.run.record },
        ],
      };
      setState({
        activity: { board: performed.board, status: "finished" },
        runs: state.runs.map((known) =>
          known.id === runId ? regenerated : known
        ),
      });
    },
    async run(request) {
      if (isBusy()) {
        return;
      }
      const performed = await perform(request);
      if (!performed) {
        return;
      }
      const { prepared, run } = performed;
      const proposed = workspace.propose(run.candidates);
      if (!proposed.ok) {
        fail(performed.board, proposed.notice.message, "integrate");
        return;
      }
      const finished: ReviewedRun = {
        candidates: reviewed(run, prepared, 1),
        faceId: request.faceId,
        id: newId(),
        outcomes: performed.outcomes,
        raw: run.artefacts.raw,
        record: run.record,
        recorded: prepared.recorded,
        regenerations: [],
        request,
        sent: run.artefacts.sent,
        targets: prepared.targets,
      };
      setState({
        activity: { board: performed.board, status: "finished" },
        runs: [finished, ...state.runs],
        shownRunId: finished.id,
      });
    },
    setProviderKey: (providerKey) => setState({ providerKey }),
    showRun: (shownRunId) => setState({ shownRunId }),
    stop: () => stopper?.abort(),
    styleOf,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    updateDraft: (patch) => setState({ draft: { ...state.draft, ...patch } }),
  };
};
