/**
 * The reconstruct command. It drives the Reconstruct place's own session
 * through the steps a person takes there: open the photograph, mark the
 * region, label the letters, choose where they go, propose them, and ask a
 * recorded run for the letters the photograph does not show. The session
 * never rejects, so after each step its state is read here and a problem is
 * thrown as a refusal.
 */
import { type Reading, rectangle } from "~/reconstruct/core";
import { letterKey, type ReconstructSession } from "~/reconstruct/session";
import {
  LabelCountError,
  labelFromText,
} from "~/reconstruction/recognition/recognizer";
import type { Reconstructed, ReconstructRequest } from "./commands";
import { faceNamed } from "./faces";
import type { OpenProject } from "./open-project";
import { Refusal } from "./refusal";
import { NO_RECORDED_RUNS, runName, servedRun } from "./served-run";

const textOf = (characters: readonly number[]) =>
  String.fromCodePoint(...characters);

/** Labels every letter from the text given, in one reading of the region. */
const labelFrom = (
  session: ReconstructSession,
  readings: readonly Reading[],
  text: readonly string[],
  read: () => void
) => {
  let labelled: Reading[];
  try {
    labelled = labelFromText(readings, text);
  } catch (error) {
    if (!(error instanceof LabelCountError)) {
      throw error;
    }
    throw new Refusal(error.message, { cause: error });
  }
  for (const reading of labelled) {
    session.label(letterKey(reading), reading.character);
  }
  read();
};

/** Asks the recorded run for the missing letters and proposes them. */
const complete = async (session: ReconstructSession) => {
  session.updateCompletionDraft({ strategy: "recorded-run" });
  await session.listRecorded();
  const { catalogue } = session.getState();
  if (catalogue.status === "failed") {
    throw new Refusal(catalogue.reason);
  }
  await session.complete();
  const { completion, completionProblem } = session.getState();
  if (!completion) {
    throw new Refusal(
      completionProblem ?? "The missing letters were not asked for."
    );
  }
  session.proposeInferred();
  const proposed = session.getState();
  if (!proposed.completion?.proposed) {
    throw new Refusal(
      proposed.completionProblem ??
        "The inferred letters were not proposed to the project."
    );
  }
  return proposed.completion;
};

export const reconstruct = async (
  open: OpenProject,
  request: ReconstructRequest
): Promise<Reconstructed> => {
  const { means, places, store, workspace } = open;
  const photograph = open
    .kept()
    .photographs.find((known) => known.artifactId === request.photograph);
  if (!photograph) {
    throw new Refusal(
      `This project has no photograph ${request.photograph}. Import the photograph first, then name its artifact.`
    );
  }
  const recorded = request.complete && {
    files: await means.readRecordedRun(request.complete.recordedRun),
    name: runName(request.complete.recordedRun),
  };
  // The session reads the region again after every label. Readings are held
  // back here and the last one is run, once, when the labels are all given.
  const waiting: (() => void)[] = [];
  const read = () => {
    const latest = waiting.pop();
    waiting.length = 0;
    latest?.();
  };
  const session = places.reconstruct(
    recorded ? servedRun(recorded.name, recorded.files) : NO_RECORDED_RUNS,
    (work) => waiting.push(work)
  );

  await session.openEvidence({
    bytes: await store.read({ artifactId: photograph.artifactId }),
    fileName: photograph.fileName,
  });
  const { evidenceProblem } = session.getState();
  if (evidenceProblem) {
    throw new Refusal(evidenceProblem);
  }
  const { height, width, x, y } = request.region;
  session.markRegion(rectangle(x, y, width, height));
  read();
  const found = session.getState();
  if (!found.reading) {
    throw new Refusal(found.readingProblem ?? "The region could not be read.");
  }
  if (request.text) {
    labelFrom(session, found.reading.readings, request.text, read);
  }
  session.setDestination(
    request.destination.kind === "new"
      ? request.destination
      : {
          faceId: faceNamed(
            workspace.getState().project,
            request.destination.faceId
          ).id,
          kind: "existing",
        }
  );
  await session.propose();
  const { proposal, proposalProblem, reading } = session.getState();
  if (!(proposal && reading)) {
    throw new Refusal(proposalProblem ?? "The letters were not proposed.");
  }
  // The new face's empty font arrived through the session, not an import.
  await open.keepSources();
  const completion = recorded ? await complete(session) : undefined;
  if (completion) {
    open.keep({
      verdicts: {
        ...open.kept().verdicts,
        ...Object.fromEntries(
          [...completion.inference.run.evaluations].map(
            ([candidateId, evaluation]) => [candidateId, evaluation.verdict]
          )
        ),
      },
    });
  }
  return {
    faceId: proposal.faceId,
    found: reading.readings.length,
    inferred: (completion?.candidates ?? []).map((candidate) => ({
      id: candidate.id,
      model: completion?.record.model,
      recorded: completion?.record.recorded ?? false,
      text: textOf(candidate.characters),
    })),
    modelOutput:
      recorded && (await store.keepModelOutput(recorded.name, recorded.files)),
    observed: proposal.letters.map(({ candidate, character, fit }) => ({
      fit,
      id: candidate.id,
      text: textOf([character]),
    })),
  };
};
