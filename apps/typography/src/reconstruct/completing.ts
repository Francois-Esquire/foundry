/**
 * Completing the alphabet: asking a generation strategy for the characters
 * the evidence does not show, keeping what a model returned, and proposing
 * what it drew. Every letter made here is inferred, never observed. The
 * Reconstruct place's session and the reconstruct command call these.
 */

import { keepRunOutput } from "~/generation/model-output";
import type { RunRecord } from "~/generation/pipeline/run";
import { liveStrategy } from "~/generation/strategies/offering";
import {
  loadRecorded,
  type RecordedEntry,
} from "~/generation/strategies/recorded/catalogue";
import { recordedRunStrategy } from "~/generation/strategies/recorded/recorded-run";
import type {
  GenerationStrategy,
  StrategyKind,
} from "~/generation/strategies/strategy";
import { Refusal } from "~/lib/refusal";
import type { NewCandidate } from "~/typeface/project";
import type { RunMeans } from "~/workspace/run-means";
import type { Workspace } from "~/workspace/workspace";
import { recordedAvailability } from "./completion";
import { missingFromAlphabet, wantedCharacters } from "./considered-characters";
import { type Evidence, type Inference, inferCharacters } from "./core";
import {
  DESTINATION_GONE,
  destinationStands,
  type Proposal,
  targetFor,
} from "./proposing";
import type { LetterReading } from "./reading";

/** One answer of a generation strategy to a request for missing characters. */
export interface Completion {
  /** The inferred candidates as they stand, narrowed or not. */
  readonly candidates: readonly NewCandidate[];
  readonly inference: Inference;
  /** The artifact that holds what a model returned. Absent when no model drew the letters. */
  readonly modelOutput?: string;
  /** What every outline was multiplied by across, once a person asked for it. */
  readonly narrowedBy?: number;
  /** True once the candidates went to the project. */
  readonly proposed: boolean;
  /** Says what drew the letters, and whether live or replayed from a recording. */
  readonly record: RunRecord;
  readonly wanted: readonly number[];
}

/** What is asked of a strategy. */
export interface CompletionAsk {
  /** The recorded run to replay, when that is the strategy. */
  readonly recorded?: RecordedEntry;
  readonly strategy: StrategyKind;
  /**
   * The characters asked of a strategy that draws, as typed. When none are
   * named, the rest of the basic alphabet is asked for.
   */
  readonly wanted?: string;
}

/**
 * The default recorded run for a photograph: the one
 * made for the photograph, else the first listed.
 */
export const recordedFor = (
  entries: readonly RecordedEntry[],
  evidenceFileName: string | undefined
): RecordedEntry | undefined =>
  entries.find((entry) => entry.evidenceFile === evidenceFileName) ??
  entries[0];

/** The strategy to ask, the characters to ask it for, and the recorded run it replays when it is one. */
const asked = async (
  { recorded, strategy, wanted }: CompletionAsk,
  evidence: Evidence,
  proposal: Proposal,
  { clock, codec, modelFetch, providerKey, runs }: RunMeans
): Promise<{
  replayed?: RecordedEntry;
  strategy: GenerationStrategy;
  wanted: number[];
}> => {
  if (strategy === "recorded-run") {
    const availability = recordedAvailability(recorded, evidence.fileName);
    if (!(recorded && availability.available)) {
      throw new Refusal(
        availability.available
          ? "No recorded run was chosen."
          : availability.reason
      );
    }
    return {
      replayed: recorded,
      strategy: recordedRunStrategy(await loadRecorded(runs, recorded)),
      wanted: wantedCharacters(recorded.targets.join("")),
    };
  }
  return {
    strategy: liveStrategy(strategy, {
      clock,
      codec,
      fetch: modelFetch,
      providerKey: providerKey(),
    }),
    wanted: wantedCharacters(
      wanted ??
        missingFromAlphabet(proposal.letters.map((letter) => letter.character))
    ),
  };
};

/**
 * Asks a strategy for the characters the proposed letters lack, drawn to go
 * with them, and keeps what a model returned for them. Nothing goes to the
 * project. Refuses when the face the letters
 * went to has left the project, when the recorded run was made for another
 * photograph, and with the strategy's own reason when it cannot run.
 */
export const completeLetters = async (
  ask: CompletionAsk,
  {
    evidence,
    proposal,
    reading,
  }: {
    readonly evidence: Evidence;
    readonly proposal: Proposal;
    readonly reading: LetterReading;
  },
  means: RunMeans,
  signal?: AbortSignal
): Promise<Completion> => {
  const { workspace } = means;
  if (!destinationStands(proposal, workspace.getState().project)) {
    throw new Refusal(DESTINATION_GONE);
  }
  const { replayed, strategy, wanted } = await asked(
    ask,
    evidence,
    proposal,
    means
  );
  const [nearest] = reading.nearest;
  const inference = await inferCharacters({
    clock: means.clock,
    codec: means.codec,
    evidence,
    newId: means.newId,
    observed: proposal.letters,
    signal,
    strategy,
    target: targetFor(workspace, proposal.faceId),
    wanted,
    widthReference: reading.faces.find(
      (reference) => reference.id === nearest?.reference
    ),
  });
  return {
    candidates: inference.candidates,
    inference,
    modelOutput: await keepRunOutput(
      replayed
        ? { recorded: replayed }
        : { run: inference.run, targets: inference.targets },
      means
    ),
    proposed: false,
    record: inference.run.record,
    wanted,
  };
};

/**
 * Proposes the inferred letters to the face the observed ones went to.
 * Refuses when that face has left the project: asked of the project, that
 * would be refused with a notice that names the face by its id.
 */
export const proposeInferred = (
  workspace: Pick<Workspace, "getState" | "propose">,
  proposal: Proposal,
  completion: Completion
): Completion => {
  if (!destinationStands(proposal, workspace.getState().project)) {
    throw new Refusal(DESTINATION_GONE);
  }
  const outcome = workspace.propose(completion.candidates);
  if (!outcome.ok) {
    throw new Refusal(outcome.notice.message);
  }
  return { ...completion, proposed: true };
};
