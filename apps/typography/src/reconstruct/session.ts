/**
 * The Reconstruct place's session: the evidence that is open, the region
 * marked on it, how its lettering is read, and what was proposed from it.
 * The project holds no evidence, and the screen is taken down whenever a
 * person looks at another place, so all of this lives here, in memory, for
 * as long as the page does. Candidates go to the workspace, and their
 * standing is always read from there.
 */
import type { RunRecord } from "~/generation/pipeline/run";
import type { NewCandidate } from "~/generation/pipeline/stages";
import type { ImageCodec } from "~/generation/raster/image-codec";
import { UnreadableImageError } from "~/generation/raster/image-codec";
import { recordedRunStrategy } from "~/generation/strategies/recorded/recorded-run";
import type {
  GenerationStrategy,
  StrategyKind,
} from "~/generation/strategies/strategy";
import type { FontBuilder } from "~/packaging/building";
import { type FaceId, isEditable } from "~/typeface/face";
import { outlineToPath } from "~/typeface/outline";
import { digestOf, type TypefaceProject } from "~/typeface/project";
import type { Workspace } from "~/workspace/workspace";
import {
  listRecordedCompletions,
  liveStrategy,
  loadRecordedCompletion,
  type RecordedCompletion,
  type RecordedCompletions,
  recordedAvailability,
} from "./completion";
import {
  type Considered,
  consideredCharacters,
  missingFromAlphabet,
  wantedCharacters,
} from "./considered-characters";
import {
  type Evidence,
  type EvidenceRegion,
  type FaceMatch,
  type Inference,
  inferCharacters,
  type LetteringPolarity,
  type LetterReader,
  labelReading,
  letterReader,
  narrowToObserved,
  type Reading,
  type RecoveredLetter,
  type Recovery,
  type RecoveryMetrics,
  type ReferenceFace,
  readEvidence,
  recover,
  type SeparationMethod,
  type Sighting,
  STANDARD_METRICS,
  sight,
  type Target,
} from "./core";
import {
  blankFileName,
  blankFontFor,
  type Destination,
  familyNameFrom,
  metricsOf,
} from "./destination";
import { referenceFaces, referencesKey } from "./references";
import type { Fetch } from "./samples";

export interface ReadingOptions {
  readonly by: SeparationMethod;
  readonly considered: Considered;
  /** Automatic reads the polarity from the picture: the class along the border is the ground. */
  readonly lettering: "automatic" | LetteringPolarity;
  readonly ruledLines: boolean;
  /** How many view pixels are made from one pixel of the photograph. */
  readonly scale: number;
}

/** Everything read from the marked region as the labels stand now. */
export interface LetterReading {
  /** The library faces ranked by resemblance to the lettering as labelled. */
  readonly nearest: readonly FaceMatch[];
  readonly readings: readonly Reading[];
  /** The letters traced against no face in particular, for inspecting their fit. */
  readonly recovery: Recovery;
  /** How many reference faces the letters were read against. */
  readonly references: number;
  readonly sighting: Sighting;
}

/** What was proposed from this evidence, and to which face. */
export interface Proposal {
  readonly faceId: FaceId;
  /**
   * Ids of letters that were proposed before with another outline, from
   * another marking of the same photograph. The project's candidate stands,
   * so that is the outline shown, and the fit of the newer tracing is not
   * its fit.
   */
  readonly kept: ReadonlySet<string>;
  /** The letters proposed, one for each distinct character, as the project holds them. */
  readonly letters: readonly RecoveredLetter[];
  readonly metrics: RecoveryMetrics;
  /** Letters left out because a candidate from this evidence already holds their place on another face. */
  readonly taken: number;
}

type CatalogueState =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "listed"; readonly catalogue: RecordedCompletions };

/** One answer of a generation strategy to a request for missing characters. */
export interface Completion {
  /** The inferred candidates as they stand, narrowed or not. */
  readonly candidates: readonly NewCandidate[];
  readonly inference: Inference;
  /** What every outline was multiplied by across, once a person asked for it. */
  readonly narrowedBy?: number;
  /** True once the candidates went to the project. */
  readonly proposed: boolean;
  /** Says what drew the letters, and whether live or replayed from a recording. */
  readonly record: RunRecord;
  readonly wanted: readonly number[];
}

interface CompletionDraft {
  /** In memory only. Never written to storage. */
  readonly providerKey: string;
  /** The id of the recorded run to replay, or empty before one is chosen. */
  readonly recordedId: string;
  readonly strategy: StrategyKind;
  /** The characters asked for, as typed. Empty means the rest of the basic alphabet. */
  readonly wanted: string;
}

export interface ReconstructState {
  readonly catalogue: CatalogueState;
  readonly completing: boolean;
  readonly completion?: Completion;
  readonly completionDraft: CompletionDraft;
  readonly completionProblem?: string;
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
  readonly proposal?: Proposal;
  readonly proposalProblem?: string;
  readonly proposing: boolean;
  readonly reading?: LetterReading;
  readonly readingProblem?: string;
  readonly region?: EvidenceRegion;
  /** True while the region is being read again. */
  readonly working: boolean;
}

export interface SessionMeans {
  /** Where the app is served from, ending in a slash. */
  readonly base: string;
  readonly builder: Pick<FontBuilder, "blankFont">;
  /** Says when a completion started, ended and produced its output. The system clock when absent. */
  readonly clock?: () => Date;
  readonly codec: ImageCodec;
  /**
   * Runs the reading after the screen has drawn. Tests pass a function that
   * runs it at once.
   */
  readonly defer?: (work: () => void) => void;
  /** Fetches the recorded runs served with the app. */
  readonly fetch: Fetch;
  /** Replaces the network for model calls in tests. */
  readonly modelFetch?: typeof fetch;
  /** Makes a completion's run id, which its candidates' ids begin with. Random when absent. */
  readonly newId?: () => string;
  readonly workspace: Workspace;
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
  /** Never rejects: a file that is not a picture is in `evidenceProblem`. */
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
  subscribe(listener: () => void): () => void;
  updateCompletionDraft(patch: Partial<CompletionDraft>): void;
}

/** The key of a found letter: its line and its place in the line. */
export const letterKey = (reading: {
  readonly index: number;
  readonly line: number;
}) => `${reading.line}.${reading.index}`;

/**
 * The recorded run that would be replayed: the one chosen, else the one made
 * for the open photograph, else the first listed.
 */
export const chosenRecorded = ({
  catalogue,
  completionDraft,
  evidence,
}: ReconstructState): RecordedCompletion | undefined => {
  if (catalogue.status !== "listed") {
    return;
  }
  const { entries } = catalogue.catalogue;
  return (
    entries.find((entry) => entry.id === completionDraft.recordedId) ??
    entries.find((entry) => entry.evidenceFile === evidence?.fileName) ??
    entries[0]
  );
};

/** True while the face a proposal's letters went to is still in the project. */
export const destinationStands = (
  proposal: Proposal,
  project: TypefaceProject
) => project.faces.some((face) => face.id === proposal.faceId);

/** What to say, in every place that would propose or infer, once that face is gone. */
export const DESTINATION_GONE =
  "The face these letters were going to is no longer in the project. Choose a destination again, then propose the letters to it.";

const sameDesign = (a: NewCandidate, b: NewCandidate) =>
  a.advance === b.advance &&
  outlineToPath(a.outline) === outlineToPath(b.outline);

const DRAFT_TARGET: Target = {
  faceId: "reconstruction-draft",
  metrics: STANDARD_METRICS,
};

const INITIAL_OPTIONS: ReadingOptions = {
  by: "colour",
  considered: "letters",
  lettering: "automatic",
  ruledLines: false,
  scale: 2,
};

const INITIAL_DRAFT: CompletionDraft = {
  providerKey: "",
  recordedId: "",
  strategy: "procedural",
  wanted: "",
};

const reasonOf = (error: unknown): string => {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "The request was stopped before it finished.";
  }
  return error instanceof Error ? error.message : String(error);
};

interface Sighted {
  readonly evidence: Evidence;
  readonly key: string;
  readonly region: EvidenceRegion;
  readonly sighting: Sighting;
}

interface MachineReading {
  readonly key: string;
  readonly reader: LetterReader;
  readonly readings: readonly Reading[];
  readonly references: readonly ReferenceFace[];
  readonly sighting: Sighting;
}

export const createReconstructSession = (
  means: SessionMeans
): ReconstructSession => {
  const { workspace } = means;
  const defer =
    means.defer ??
    ((work: () => void) => {
      setTimeout(work, 0);
    });
  const listeners = new Set<() => void>();
  let sighted: Sighted | undefined;
  let machine: MachineReading | undefined;
  let stopper: AbortController | undefined;
  let state: ReconstructState = {
    catalogue: { status: "idle" },
    completing: false,
    completionDraft: INITIAL_DRAFT,
    destination: { familyName: "", kind: "new" },
    labels: new Map(),
    options: INITIAL_OPTIONS,
    proposing: false,
    working: false,
  };

  const setState = (patch: Partial<ReconstructState>) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const references = (): ReferenceFace[] =>
    referenceFaces(
      workspace.getState().project.faces,
      (face) => workspace.openFace(face.id),
      consideredCharacters(state.options.considered)
    );

  const sightingOf = (
    evidence: Evidence,
    region: EvidenceRegion,
    options: ReadingOptions
  ): Sighting => {
    const key = [
      options.by,
      options.lettering,
      options.ruledLines,
      options.scale,
    ].join("|");
    if (
      sighted?.evidence !== evidence ||
      sighted.region !== region ||
      sighted.key !== key
    ) {
      sighted = {
        evidence,
        key,
        region,
        sighting: sight(evidence, region, {
          by: options.by,
          lettering:
            options.lettering === "automatic" ? undefined : options.lettering,
          ruledLines: options.ruledLines,
          scale: options.scale,
        }),
      };
    }
    return sighted.sighting;
  };

  /** What the recogniser makes of a sighting. Read once for a sighting and a set of references. */
  const machineReading = (
    sighting: Sighting,
    options: ReadingOptions
  ): MachineReading => {
    const faces = references();
    const key = `${options.considered}|${referencesKey(faces)}`;
    if (machine?.sighting !== sighting || machine.key !== key) {
      const reader = letterReader(
        faces,
        consideredCharacters(options.considered)
      );
      machine = {
        key,
        reader,
        readings: reader.read(sighting),
        references: faces,
        sighting,
      };
    }
    return machine;
  };

  const readRegion = () => {
    const { evidence, labels, options, region } = state;
    if (!(evidence && region)) {
      setState({
        reading: undefined,
        readingProblem: undefined,
        working: false,
      });
      return;
    }
    try {
      const sighting = sightingOf(evidence, region, options);
      const read = machineReading(sighting, options);
      const readings = read.readings.map((reading) => {
        const key = letterKey(reading);
        return labels.has(key)
          ? labelReading(reading, labels.get(key))
          : reading;
      });
      setState({
        reading: {
          nearest: read.reader.nearest(sighting, readings),
          readings,
          recovery: recover(evidence, sighting, readings, DRAFT_TARGET),
          references: read.references.length,
          sighting,
        },
        readingProblem: undefined,
        working: false,
      });
    } catch (error) {
      setState({
        reading: undefined,
        readingProblem: `This region could not be read. ${reasonOf(error)} Mark the region again, or change how the lettering is separated.`,
        working: false,
      });
    }
  };

  /** Shows that work is under way, then does it once the screen has drawn. */
  const readSoon = (patch: Partial<ReconstructState>) => {
    setState({ ...patch, working: true });
    defer(readRegion);
  };

  const locked = () => state.proposal !== undefined || state.proposing;

  const destinationFace = async (): Promise<FaceId> => {
    const { destination } = state;
    const { project } = workspace.getState();
    if (destination.kind === "existing") {
      const face = project.faces.find(
        (candidate) => candidate.id === destination.faceId
      );
      if (!(face && isEditable(face))) {
        throw new Error(
          "Choose a face for the letters, or make a new face for them."
        );
      }
      return face.id;
    }
    if (destination.familyName.trim() === "") {
      throw new Error("Give the new face a name, then propose the letters.");
    }
    const built = await means.builder.blankFont(
      blankFontFor(destination.familyName)
    );
    // The same name makes the same file, which the project already holds
    // when this reconstruction, or an earlier one of that name, made it.
    const sourceId = await digestOf(built.bytes);
    const existing = workspace
      .getState()
      .project.faces.find((face) => face.sourceId === sourceId);
    if (existing) {
      return existing.id;
    }
    const [report] = await workspace.importFonts([
      {
        bytes: built.bytes,
        madeFor: "reconstruction",
        name: blankFileName(destination.familyName),
      },
    ]);
    const faceId =
      report?.status === "imported" ? report.faceIds[0] : undefined;
    if (faceId === undefined) {
      throw new Error(
        "The new face could not be added to the project. Try another name."
      );
    }
    return faceId;
  };

  const targetFor = (faceId: FaceId): Target => {
    const face = workspace.openFace(faceId);
    return { face, faceId, metrics: metricsOf(face.description.metrics) };
  };

  const proposeTo = (
    faceId: FaceId,
    evidence: Evidence,
    read: LetterReading
  ) => {
    const target = targetFor(faceId);
    const { distinct } = recover(
      evidence,
      read.sighting,
      read.readings,
      target
    );
    const standing = new Map(
      workspace
        .getState()
        .project.candidates.map((candidate) => [candidate.id, candidate])
    );
    // A candidate's id names the evidence and the letter, not the face, so
    // one letter of one photograph can be proposed to one face only.
    const here = distinct.filter(
      ({ candidate }) =>
        (standing.get(candidate.id)?.faceId ?? faceId) === faceId
    );
    const fresh = here.filter(({ candidate }) => !standing.has(candidate.id));
    const outcome =
      fresh.length > 0
        ? workspace.propose(fresh.map((letter) => letter.candidate))
        : undefined;
    if (outcome && !outcome.ok) {
      throw new Error(outcome.notice.message);
    }
    // A candidate cannot be withdrawn or proposed twice. Where one already
    // stands for a letter, it is what Accept adds, so it is what is shown.
    const kept = new Set<string>();
    const letters = here.map((letter): RecoveredLetter => {
      const held = standing.get(letter.candidate.id);
      if (!held || sameDesign(held, letter.candidate)) {
        return letter;
      }
      kept.add(held.id);
      const { status: _status, ...candidate } = held;
      return { ...letter, candidate };
    });
    setState({
      completion: undefined,
      completionProblem: undefined,
      proposal: {
        faceId,
        kept,
        letters,
        metrics: target.metrics,
        taken: distinct.length - here.length,
      },
    });
  };

  /** The strategy to ask and the characters to ask it for. */
  const completionRequest = async (
    evidence: Evidence,
    proposal: Proposal
  ): Promise<{ strategy: GenerationStrategy; wanted: number[] }> => {
    const { completionDraft } = state;
    if (completionDraft.strategy === "recorded-run") {
      const entry = chosenRecorded(state);
      const availability = recordedAvailability(entry, evidence.fileName);
      if (!(entry && availability.available)) {
        throw new Error(
          availability.available
            ? "No recorded run was chosen."
            : availability.reason
        );
      }
      return {
        strategy: recordedRunStrategy(
          await loadRecordedCompletion(means.fetch, means.base, entry)
        ),
        wanted: wantedCharacters(entry.targets.join("")),
      };
    }
    const observed = proposal.letters.map((letter) => letter.character);
    return {
      strategy: liveStrategy(completionDraft.strategy, {
        clock: means.clock,
        codec: means.codec,
        fetch: means.modelFetch,
        providerKey: completionDraft.providerKey,
      }),
      wanted: wantedCharacters(
        completionDraft.wanted.trim() === ""
          ? missingFromAlphabet(observed)
          : completionDraft.wanted
      ),
    };
  };

  return {
    clearLabel(key) {
      if (locked() || !state.labels.has(key)) {
        return;
      }
      const labels = new Map(state.labels);
      labels.delete(key);
      readSoon({ labels });
    },
    closeEvidence() {
      stopper?.abort();
      sighted = undefined;
      machine = undefined;
      setState({
        completion: undefined,
        completionProblem: undefined,
        evidence: undefined,
        evidenceProblem: undefined,
        labels: new Map(),
        proposal: undefined,
        proposalProblem: undefined,
        reading: undefined,
        readingProblem: undefined,
        region: undefined,
      });
    },
    async complete() {
      const { evidence, proposal, reading } = state;
      if (!(evidence && proposal && reading) || state.completing) {
        return;
      }
      if (!destinationStands(proposal, workspace.getState().project)) {
        setState({
          completion: undefined,
          completionProblem: DESTINATION_GONE,
        });
        return;
      }
      stopper = new AbortController();
      setState({
        completing: true,
        completion: undefined,
        completionProblem: undefined,
      });
      try {
        const { strategy, wanted } = await completionRequest(
          evidence,
          proposal
        );
        const [nearest] = reading.nearest;
        const inference = await inferCharacters({
          clock: means.clock,
          codec: means.codec,
          evidence,
          newId: means.newId,
          observed: proposal.letters,
          signal: stopper.signal,
          strategy,
          target: targetFor(proposal.faceId),
          wanted,
          widthReference: machine?.references.find(
            (reference) => reference.id === nearest?.reference
          ),
        });
        setState({
          completing: false,
          completion: {
            candidates: inference.candidates,
            inference,
            proposed: false,
            record: inference.run.record,
            wanted,
          },
        });
      } catch (error) {
        setState({ completing: false, completionProblem: reasonOf(error) });
      }
    },
    getState: () => state,
    label(key, character) {
      if (locked()) {
        return;
      }
      readSoon({ labels: new Map(state.labels).set(key, character) });
    },
    async listRecorded() {
      if (state.catalogue.status !== "idle") {
        return;
      }
      setState({ catalogue: { status: "loading" } });
      try {
        const catalogue = await listRecordedCompletions(
          means.fetch,
          means.base
        );
        setState({ catalogue: { catalogue, status: "listed" } });
      } catch (error) {
        setState({ catalogue: { reason: reasonOf(error), status: "failed" } });
      }
    },
    markRegion(region) {
      if (locked() || !state.evidence) {
        return;
      }
      readSoon({ labels: new Map(), region });
    },
    narrow() {
      const { completion } = state;
      if (!completion || completion.proposed) {
        return;
      }
      const { candidates, factor } = narrowToObserved(completion.inference);
      setState({
        completion: { ...completion, candidates, narrowedBy: factor },
      });
    },
    async openEvidence(file) {
      stopper?.abort();
      setState({ evidenceProblem: undefined, opening: file.fileName });
      try {
        const evidence = await readEvidence(file, means.codec);
        sighted = undefined;
        machine = undefined;
        setState({
          completion: undefined,
          completionProblem: undefined,
          destination: {
            familyName: familyNameFrom(evidence.fileName),
            kind: "new",
          },
          evidence,
          labels: new Map(),
          opening: undefined,
          proposal: undefined,
          proposalProblem: undefined,
          reading: undefined,
          readingProblem: undefined,
          region: undefined,
        });
      } catch (error) {
        if (!(error instanceof UnreadableImageError)) {
          throw error;
        }
        setState({
          evidenceProblem: `${file.fileName} could not be read as a picture. Choose a JPEG, PNG or WebP file.`,
          opening: undefined,
        });
      }
    },
    async propose() {
      const { evidence, reading } = state;
      if (!(evidence && reading) || locked()) {
        return;
      }
      setState({ proposalProblem: undefined, proposing: true });
      try {
        proposeTo(await destinationFace(), evidence, reading);
        setState({ proposing: false });
      } catch (error) {
        setState({ proposalProblem: reasonOf(error), proposing: false });
      }
    },
    proposeInferred() {
      const { completion, proposal } = state;
      if (!(completion && proposal) || completion.proposed) {
        return;
      }
      // Asked of the project, this would be refused with a notice that
      // names the face by its id.
      if (!destinationStands(proposal, workspace.getState().project)) {
        setState({ completionProblem: DESTINATION_GONE });
        return;
      }
      const outcome = workspace.propose(completion.candidates);
      if (outcome.ok) {
        setState({ completion: { ...completion, proposed: true } });
      } else {
        setState({ completionProblem: outcome.notice.message });
      }
    },
    refresh() {
      if (
        state.reading &&
        !locked() &&
        machine?.key !==
          `${state.options.considered}|${referencesKey(references())}`
      ) {
        readSoon({});
      }
    },
    reopen() {
      stopper?.abort();
      setState({
        completion: undefined,
        completionProblem: undefined,
        proposal: undefined,
        proposalProblem: undefined,
      });
    },
    setDestination(destination) {
      if (!locked()) {
        setState({ destination, proposalProblem: undefined });
      }
    },
    setOptions(patch) {
      if (locked()) {
        return;
      }
      const options = { ...state.options, ...patch };
      // Another sighting finds other letters, so labels given to the old
      // ones no longer name anything.
      const sameLetters =
        options.by === state.options.by &&
        options.lettering === state.options.lettering &&
        options.ruledLines === state.options.ruledLines &&
        options.scale === state.options.scale;
      readSoon({
        labels: sameLetters ? state.labels : new Map(),
        options,
      });
    },
    stop: () => stopper?.abort(),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    updateCompletionDraft(patch) {
      setState({
        completionDraft: { ...state.completionDraft, ...patch },
        completionProblem: undefined,
      });
    },
  };
};
