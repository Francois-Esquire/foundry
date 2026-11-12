/**
 * The Reconstruct place's session: the evidence that is open, the region
 * marked on it, how its lettering is read, and what was proposed from it.
 * The screen is taken down whenever a person looks at another place, so all
 * of this lives here, in memory, for as long as the page does. What outlasts
 * it goes to the project: a photograph that is opened is kept and listed
 * there, candidates go to the workspace, and their standing is always read
 * from there.
 *
 * The work is one line: evidence, then a reading of its region, then a
 * proposal, then a completion. Each is an operation of this place, and a
 * change to one clears everything after it.
 */

import {
  type StrategyOption,
  strategyOptions,
} from "~/generation/strategies/offering";
import {
  listRecorded,
  type RecordedEntry,
} from "~/generation/strategies/recorded/catalogue";
import type {
  Availability,
  StrategyKind,
} from "~/generation/strategies/strategy";
import { reasonOf } from "~/lib/reason";
import { createStore } from "~/lib/store";
import type { FontBuilder } from "~/packaging/building";
import type { CatalogueState } from "~/workspace/recorded-catalogue";
import type { RunMeans } from "~/workspace/run-means";
import {
  type Completion,
  completeLetters,
  proposeInferred,
  recordedFor,
} from "./completing";
import { ORDER, photographRuns, SUMMARIES } from "./completion";
import { type Evidence, type EvidenceRegion, narrowToObserved } from "./core";
import { type Destination, familyNameFrom } from "./destination";
import { type Proposal, proposeLetters } from "./proposing";
import {
  type EvidenceMeans,
  keepEvidence,
  type LetterReading,
  labelLetters,
  type ReadingMemo,
  type ReadingOptions,
  readAgainstOthers,
  readLetters,
  readSighting,
  sightingKey,
  USUAL_OPTIONS,
} from "./reading";

interface CompletionDraft {
  /** The id of the recorded run to replay, or empty before one is chosen. */
  readonly recordedId: string;
  readonly strategy: StrategyKind;
  /** The characters asked for, as typed. Empty means the rest of the basic alphabet. */
  readonly wanted: string;
}

/** One stage of a reconstruction: what it made, why it failed, and whether it is at work. */
interface Step<T> {
  readonly problem?: string;
  readonly status: "idle" | "working" | "done";
  readonly value?: T;
}

/** The stages in order. Clearing one clears the ones after it. */
const STAGES = ["evidence", "reading", "proposal", "completion"] as const;
type Stage = (typeof STAGES)[number];

const emptied = <T>({ status }: Step<T>): Step<T> => ({
  status: status === "working" ? "working" : "idle",
});

export interface ReconstructState {
  readonly catalogue: CatalogueState;
  readonly completion: Step<Completion>;
  readonly completionDraft: CompletionDraft;
  readonly destination: Destination;
  readonly evidence?: Evidence;
  readonly evidenceProblem?: string;
  /**
   * A person's labels by letter key. A key with no character means the
   * shape was left out: it is not a letter, or not one to recover.
   */
  readonly labels: ReadonlyMap<string, number | undefined>;
  /** The file being opened, while it is read. */
  readonly opening?: string;
  readonly options: ReadingOptions;
  readonly proposal: Step<Proposal>;
  readonly reading: Step<LetterReading>;
  readonly region?: EvidenceRegion;
}

export interface SessionMeans
  extends RunMeans,
    Pick<EvidenceMeans, "keepPhotograph"> {
  readonly builder: Pick<FontBuilder, "blankFont">;
}

export interface ReconstructSession {
  /** Puts a reading back to what the recogniser said. */
  clearLabel(key: string): void;
  closeEvidence(): void;
  /** Asks the chosen strategy for the wanted characters. Never rejects. */
  complete(): Promise<void>;
  getState(): ReconstructState;
  /** A person's label for one letter. No character leaves the shape out. */
  label(key: string, character: number | undefined): void;
  /** Lists the recorded runs made for photographs. Does nothing once listed. */
  listRecorded(): Promise<void>;
  markRegion(region: EvidenceRegion | undefined): void;
  /** Brings the inferred letters to the width of the observed ones. */
  narrow(): void;
  /**
   * Opens a picture and keeps it as a photograph of the project. Never
   * rejects: a file that is not a picture is in `evidenceProblem`.
   */
  openEvidence(file: {
    readonly bytes: Uint8Array;
    readonly fileName: string;
  }): Promise<void>;
  /** Proposes the observed letters to the destination. Never rejects. */
  propose(): Promise<void>;
  proposeInferred(): void;
  /** Reads the region again if the library's faces have changed. */
  refresh(): void;
  /** Lets the region and the labels change again. Candidates already proposed stay in the project. */
  reopen(): void;
  setDestination(destination: Destination): void;
  setOptions(patch: Partial<ReadingOptions>): void;
  /** Stops the completion under way. */
  stop(): void;
  /**
   * The four strategies, each with whether it can run now with the provider
   * key as it stands. `recorded` is whether a recorded run can be replayed,
   * which the caller decides.
   */
  strategyOptions(recorded: Availability): StrategyOption[];
  subscribe(listener: () => void): () => void;
  updateCompletionDraft(patch: Partial<CompletionDraft>): void;
}

/**
 * The recorded run that would be replayed: the one chosen, else the one made
 * for the open photograph, else the first listed.
 */
export const chosenRecorded = ({
  catalogue,
  completionDraft,
  evidence,
}: ReconstructState): RecordedEntry | undefined => {
  if (catalogue.status !== "listed") {
    return undefined;
  }
  const { entries } = catalogue.catalogue;
  return (
    (completionDraft.recordedId
      ? entries.find((entry) => entry.id === completionDraft.recordedId)
      : undefined) ?? recordedFor(entries, evidence?.fileName)
  );
};

/** Whether the region and labels must hold still until the proposal is reopened. */
export const locked = (state: ReconstructState): boolean =>
  state.proposal.status !== "idle";

const INITIAL_DRAFT: CompletionDraft = {
  recordedId: "",
  strategy: "procedural",
  wanted: "",
};

/** Why it failed. A request a person stopped says so in plain words. */
const failureOf = (error: unknown): string =>
  error instanceof DOMException && error.name === "AbortError"
    ? "The request was stopped before it finished."
    : reasonOf(error);

export const createReconstructSession = (
  means: SessionMeans
): ReconstructSession => {
  const { workspace } = means;
  let stopper: AbortController | undefined;
  /** What the last reading can spare the next. It is let go with the reading. */
  let memo: ReadingMemo | undefined;
  const store = createStore<ReconstructState>({
    catalogue: { status: "idle" },
    completion: { status: "idle" },
    completionDraft: INITIAL_DRAFT,
    destination: { familyName: "", kind: "new" },
    labels: new Map(),
    options: USUAL_OPTIONS,
    proposal: { status: "idle" },
    reading: { status: "idle" },
  });
  const setState = store.patch;

  /**
   * A stage and every stage after it, emptied. Work already under way is
   * not stopped, so a stage at work stays at work until it answers.
   */
  const clearFrom = (stage: Stage): Partial<ReconstructState> => {
    const { completion, proposal, reading } = store.getState();
    const from = STAGES.indexOf(stage);
    return {
      ...(from <= STAGES.indexOf("evidence")
        ? { evidence: undefined, evidenceProblem: undefined }
        : {}),
      ...(from <= STAGES.indexOf("reading")
        ? {
            labels: new Map<string, number | undefined>(),
            reading: emptied(reading),
            region: undefined,
          }
        : {}),
      ...(from <= STAGES.indexOf("proposal")
        ? { proposal: emptied(proposal) }
        : {}),
      completion: emptied(completion),
    };
  };

  const readRegion = () => {
    const { evidence, labels, options, region } = store.getState();
    if (!(evidence && region)) {
      memo = undefined;
      setState({
        reading: { status: "idle" },
      });
      return;
    }
    try {
      const request = { evidence, labels, options, region, workspace };
      let reading: LetterReading;
      if (
        memo?.evidence !== evidence ||
        memo.region !== region ||
        memo.sightingKey !== sightingKey(options)
      ) {
        ({ memo, reading } = readLetters(request));
      } else {
        if (readAgainstOthers(memo, options, workspace)) {
          memo = readSighting(request, memo.sighting);
        }
        reading = labelLetters(memo, request);
      }
      setState({
        reading: { status: "done", value: reading },
      });
    } catch (error) {
      memo = undefined;
      setState({
        reading: {
          problem: `This region could not be read. ${reasonOf(error)} Mark the region again, or change how the lettering is separated.`,
          status: "idle",
        },
      });
    }
  };

  /** Shows that work is under way, then does it once the screen has drawn. */
  const readSoon = (patch: Partial<ReconstructState>) => {
    setState({
      ...patch,
      reading: { ...store.getState().reading, status: "working" },
    });
    setTimeout(readRegion, 0);
  };

  return {
    clearLabel(key) {
      if (locked(store.getState()) || !store.getState().labels.has(key)) {
        return;
      }
      const labels = new Map(store.getState().labels);
      labels.delete(key);
      readSoon({ labels });
    },
    closeEvidence() {
      stopper?.abort();
      memo = undefined;
      setState(clearFrom("evidence"));
    },
    async complete() {
      const {
        completion: { status },
        completionDraft,
        evidence,
        proposal: { value: proposal },
        reading: { value: reading },
      } = store.getState();
      if (!(evidence && proposal && reading) || status === "working") {
        return;
      }
      stopper = new AbortController();
      setState({ completion: { status: "working" } });
      try {
        const completion = await completeLetters(
          {
            recorded: chosenRecorded(store.getState()),
            strategy: completionDraft.strategy,
            // Nothing typed is an empty field on the screen and no request here.
            wanted: completionDraft.wanted.trim() || undefined,
          },
          { evidence, proposal, reading },
          means,
          stopper.signal
        );
        setState({ completion: { status: "done", value: completion } });
      } catch (error) {
        setState({ completion: { problem: failureOf(error), status: "idle" } });
      }
    },
    getState: store.getState,
    label(key, character) {
      if (locked(store.getState())) {
        return;
      }
      readSoon({
        labels: new Map(store.getState().labels).set(key, character),
      });
    },
    async listRecorded() {
      const { status } = store.getState().catalogue;
      if (status === "loading" || status === "listed") {
        return;
      }
      setState({ catalogue: { status: "loading" } });
      try {
        const catalogue = photographRuns(await listRecorded(means.runs));
        setState({ catalogue: { catalogue, status: "listed" } });
      } catch (error) {
        setState({ catalogue: { reason: reasonOf(error), status: "failed" } });
      }
    },
    markRegion(region) {
      if (locked(store.getState()) || !store.getState().evidence) {
        return;
      }
      readSoon({ labels: new Map(), region });
    },
    narrow() {
      const {
        completion: { value: completion },
      } = store.getState();
      if (!completion || completion.proposed) {
        return;
      }
      const { candidates, factor } = narrowToObserved(completion.inference);
      setState({
        completion: {
          ...store.getState().completion,
          value: { ...completion, candidates, narrowedBy: factor },
        },
      });
    },
    async openEvidence(file) {
      stopper?.abort();
      setState({ evidenceProblem: undefined, opening: file.fileName });
      try {
        const { evidence } = await keepEvidence(file, means);
        memo = undefined;
        setState({
          ...clearFrom("evidence"),
          destination: {
            familyName: familyNameFrom(evidence.fileName),
            kind: "new",
          },
          evidence,
          opening: undefined,
        });
      } catch (error) {
        setState({ evidenceProblem: reasonOf(error), opening: undefined });
      }
    },
    async propose() {
      const {
        destination,
        evidence,
        reading: { value: reading },
      } = store.getState();
      if (!(evidence && reading) || locked(store.getState())) {
        return;
      }
      setState({ proposal: { status: "working" } });
      try {
        const proposal = await proposeLetters({
          builder: means.builder,
          destination,
          evidence,
          reading,
          workspace,
        });
        setState({
          ...clearFrom("completion"),
          proposal: { status: "done", value: proposal },
        });
      } catch (error) {
        setState({ proposal: { problem: reasonOf(error), status: "idle" } });
      }
    },
    proposeInferred() {
      const {
        completion: { value: completion },
        proposal: { value: proposal },
      } = store.getState();
      if (!(completion && proposal) || completion.proposed) {
        return;
      }
      try {
        setState({
          completion: {
            ...store.getState().completion,
            value: proposeInferred(workspace, proposal, completion),
          },
        });
      } catch (error) {
        setState({
          completion: {
            ...store.getState().completion,
            problem: reasonOf(error),
          },
        });
      }
    },
    refresh() {
      const { options } = store.getState();
      if (
        memo &&
        !locked(store.getState()) &&
        readAgainstOthers(memo, options, workspace)
      ) {
        readSoon({});
      }
    },
    reopen() {
      stopper?.abort();
      setState(clearFrom("proposal"));
    },
    setDestination(destination) {
      if (!locked(store.getState())) {
        setState({
          destination,
          proposal: { ...store.getState().proposal, problem: undefined },
        });
      }
    },
    setOptions(patch) {
      if (locked(store.getState())) {
        return;
      }
      const before = store.getState().options;
      const options = { ...before, ...patch };
      // Another sighting finds other letters, so labels given to the old
      // ones no longer name anything.
      readSoon({
        labels:
          sightingKey(options) === sightingKey(before)
            ? store.getState().labels
            : new Map(),
        options,
      });
    },
    stop: () => stopper?.abort(),
    strategyOptions: (recorded) =>
      strategyOptions(
        {
          clock: means.clock,
          codec: means.codec,
          fetch: means.modelFetch,
          providerKey: means.providerKey(),
        },
        recorded,
        ORDER,
        SUMMARIES
      ),
    subscribe: store.subscribe,
    updateCompletionDraft(patch) {
      setState({
        completion: { ...store.getState().completion, problem: undefined },
        completionDraft: { ...store.getState().completionDraft, ...patch },
      });
    },
  };
};
