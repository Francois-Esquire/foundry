/**
 * The Generate place's session: what it remembers while the app is open and
 * the runs it makes. Evaluations and run records are not part of the
 * project, and the screen is taken down whenever a person looks at another
 * place, so they live here. Candidates themselves go to the workspace, and
 * their status is always read from there.
 *
 * Everything is held in memory only, the provider key included.
 */
import type { GenerationRun, RunRecord } from "~/generation/pipeline/run";
import type { GlyphTarget } from "~/generation/plan/target";
import {
  type CatalogueState,
  listRecorded,
  type RecordedEntry,
} from "~/generation/strategies/recorded/catalogue";
import type {
  Availability,
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
import { count } from "~/lib/count";
import { reasonOf } from "~/lib/reason";
import { createStore } from "~/lib/store";
import type { FaceId } from "~/typeface/face";
import { acceptCandidates } from "./accepting";
import { DEFAULT_SCOPE_KEY } from "./missing-characters";
import {
  type Prepared,
  performRun,
  prepareRun,
  proposeAgain,
  proposeRun,
  type ReviewedCandidate,
  type RunMeans,
  type RunRequest,
} from "./running";
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
import { type StrategyOption, strategyOptions } from "./strategies";

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

export interface SessionMeans extends RunMeans {
  /** Milliseconds since any fixed moment, for timing Analyse and Plan. */
  readonly timer: () => number;
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
  showRun(runId: string): void;
  /** Stops the run under way. */
  stop(): void;
  /**
   * The four strategies in the order they are offered, each with whether it
   * can run now with the provider key as it stands. `recorded` is whether a
   * recorded run can be replayed, which the caller decides.
   */
  strategyOptions(recorded: Availability): StrategyOption[];
  /**
   * Measures a face's source font, once, and keeps the result. The working
   * face is not measured: edits and accepted glyphs do not reach it.
   */
  styleOf(faceId: FaceId): StyleReading;
  subscribe(listener: () => void): () => void;
  updateDraft(patch: Partial<Draft>): void;
}

/** Why it failed. A run a person stopped says so in plain words. */
const failureOf = (error: unknown): string =>
  error instanceof DOMException && error.name === "AbortError"
    ? "The run was stopped before it finished."
    : reasonOf(error);

/** Lets the browser draw the stages so far before the next piece of work. */
const pause = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/** What Plan decided, in a sentence. */
const plannedDetail = ({ holdouts, parts, recorded, targets }: Prepared) =>
  recorded
    ? `The recorded run drew ${count(targets.length, "glyph")}. ${
        holdouts.size > 0
          ? `${holdouts.size} are compared with the face's own.`
          : "None is compared with the face's own."
      }`
    : [
        `${count(targets.length, "target")} planned`,
        parts > 0 ? `${count(parts, "part")} first` : "",
        holdouts.size > 0 ? `${holdouts.size} under a holdout test` : "",
      ]
        .filter(Boolean)
        .join(", ")
        .concat(".");

/** A run as far as the pipeline took it, with the board it left. */
interface Performed {
  readonly board: StageBoard;
  readonly outcomes: readonly StageOutcome[];
  readonly prepared: Prepared;
  readonly run: GenerationRun;
}

const INITIAL_DRAFT: Draft = {
  language: "",
  recordedId: "",
  scope: DEFAULT_SCOPE_KEY,
  source: "typed",
  strategy: "procedural",
  typed: "",
};

export const createGenerateSession = (means: SessionMeans): GenerateSession => {
  const { newId, timer, workspace } = means;
  const styles = new Map<FaceId, StyleReading>();
  let stopper: AbortController | undefined;
  const store = createStore<GenerateState>({
    catalogue: { status: "idle" },
    draft: INITIAL_DRAFT,
    runs: [],
  });

  const setState = store.patch;

  const styleOf = (faceId: FaceId): StyleReading => {
    const known = styles.get(faceId);
    if (known) {
      return known;
    }
    const face = workspace.openFace(faceId);
    const started = timer();
    const style = analyseStyle(face);
    const reading: StyleReading = {
      elapsedMs: timer() - started,
      sheet: renderReferenceSheet(face, style),
      style,
    };
    styles.set(faceId, reading);
    return reading;
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

  /** Analyse, Plan and the pipeline, each shown as it goes. On failure the activity says where and why. */
  const perform = async (
    request: RunRequest
  ): Promise<Performed | undefined> => {
    stopper = new AbortController();
    let board = emptyBoard();
    const show = (next: StageBoard) => {
      board = next;
      setState({ activity: { board, status: "running" } });
    };
    show(startStage(board, "analyse"));
    try {
      const reading = styleOf(request.faceId);
      const { fullName } = workspace.openFace(request.faceId).description;
      const analysed: StageOutcome = {
        detail: `${count(reading.style.characters.length, "glyph")} of ${fullName} measured, in the source font as imported.`,
        elapsedMs: reading.elapsedMs,
        stage: "analyse",
        status: "finished",
      };
      show(startStage(endStage(board, analysed), "plan"));
      const started = timer();
      const { catalogue } = store.getState();
      const prepared = await prepareRun(
        request,
        catalogue.status === "listed" ? catalogue.catalogue.entries : [],
        means
      );
      const planned: StageOutcome = {
        detail: plannedDetail(prepared),
        elapsedMs: timer() - started,
        stage: "plan",
        status: "finished",
      };
      show(endStage(board, planned));
      await pause();
      const run = await performRun(prepared, reading.style, means, {
        onProgress: (progress) => show(followProgress(board, progress)),
        signal: stopper.signal,
      });
      return {
        board,
        outcomes: [analysed, planned, ...run.record.stages],
        prepared,
        run,
      };
    } catch (error) {
      fail(board, failureOf(error));
    }
  };

  /** Integrate: what the project refuses fails the run at that stage. */
  const integrated = <Result>(
    { board }: Performed,
    put: () => Result
  ): Result | undefined => {
    try {
      return put();
    } catch (error) {
      fail(board, reasonOf(error), "integrate");
    }
  };

  const isBusy = () => store.getState().activity?.status === "running";

  return {
    acceptPassed(runId) {
      const run = store.getState().runs.find((known) => known.id === runId);
      const proposed = new Set(
        workspace
          .getState()
          .project.candidates.filter(({ status }) => status === "proposed")
          .map(({ id }) => id)
      );
      const passed = (run?.candidates ?? [])
        .filter(
          ({ candidate, evaluation }) =>
            evaluation.verdict === "pass" && proposed.has(candidate.id)
        )
        .map(({ candidate }) => candidate.id);
      return acceptCandidates(workspace, passed).accepted;
    },
    getState: store.getState,
    async listRecorded() {
      const { status } = store.getState().catalogue;
      if (status === "loading" || status === "listed") {
        return;
      }
      setState({ catalogue: { status: "loading" } });
      try {
        const catalogue = await listRecorded(means.runs);
        const { draft } = store.getState();
        setState({
          catalogue: { catalogue, status: "listed" },
          draft: {
            ...draft,
            recordedId: draft.recordedId || (catalogue.entries[0]?.id ?? ""),
          },
        });
      } catch (error) {
        setState({ catalogue: { reason: reasonOf(error), status: "failed" } });
      }
    },
    async regenerate(runId, key) {
      const run = store.getState().runs.find((known) => known.id === runId);
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
      const made =
        performed &&
        integrated(performed, () =>
          proposeAgain(workspace, performed.prepared, performed.run, previous)
        );
      if (!made) {
        return;
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
        runs: store
          .getState()
          .runs.map((known) => (known.id === runId ? regenerated : known)),
      });
    },
    async run(request) {
      if (isBusy()) {
        return;
      }
      const performed = await perform(request);
      const candidates =
        performed &&
        integrated(performed, () =>
          proposeRun(workspace, performed.prepared, performed.run)
        );
      if (!candidates) {
        return;
      }
      const { prepared, run } = performed;
      const finished: ReviewedRun = {
        candidates,
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
        runs: [finished, ...store.getState().runs],
        shownRunId: finished.id,
      });
    },
    showRun: (shownRunId) => setState({ shownRunId }),
    stop: () => stopper?.abort(),
    strategyOptions: (recorded) =>
      strategyOptions(
        {
          clock: means.clock,
          codec: means.codec,
          fetch: means.modelFetch,
          providerKey: means.providerKey(),
        },
        recorded
      ),
    styleOf,
    subscribe: store.subscribe,
    updateDraft: (patch) =>
      setState({ draft: { ...store.getState().draft, ...patch } }),
  };
};
