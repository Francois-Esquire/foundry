/**
 * The reconstruct command: the Reconstruct place's operations, in the order
 * a person takes them there. Open the photograph, read the letters of the
 * region, propose them to a face, and ask a recorded run for the letters the
 * photograph does not show.
 */
import { listRecorded } from "~/generation/strategies/recorded/catalogue";
import { Refusal } from "~/lib/refusal";
import {
  completeLetters,
  proposeInferred,
  recordedFor,
} from "~/reconstruct/completing";
import { photographRuns } from "~/reconstruct/completion";
import { rectangle } from "~/reconstruct/core";
import { proposeLetters } from "~/reconstruct/proposing";
import {
  openEvidence,
  readLetters,
  USUAL_OPTIONS,
} from "~/reconstruct/reading";
import type { Reconstructed, ReconstructRequest } from "./commands";
import { faceNamed } from "./faces";
import type { OpenProject } from "./open-project";
import { photographArtifact } from "./store";

const textOf = (characters: readonly number[]) =>
  String.fromCodePoint(...characters);

export const reconstruct = async (
  open: OpenProject,
  request: ReconstructRequest
): Promise<Reconstructed> => {
  const { means, running, store } = open;
  const { workspace } = running;
  const photograph = workspace
    .getState()
    .project.photographs.find(
      (listed) => photographArtifact(listed.id) === request.photograph
    );
  if (!photograph) {
    throw new Refusal(
      `This project has no photograph ${request.photograph}. Import the photograph first, then name its artifact.`
    );
  }
  const recorded =
    request.complete && (await means.runAt(request.complete.recordedRun));
  const evidence = await openEvidence(
    {
      bytes: await store.read({ artifactId: request.photograph }),
      fileName: photograph.fileName,
    },
    means.codec
  );
  const { height, width, x, y } = request.region;
  const { reading } = readLetters({
    evidence,
    options: USUAL_OPTIONS,
    region: rectangle(x, y, width, height),
    text: request.text,
    workspace,
  });
  const proposal = await proposeLetters({
    builder: means.builder,
    destination:
      request.destination.kind === "new"
        ? request.destination
        : {
            faceId: faceNamed(
              workspace.getState().project,
              request.destination.faceId
            ).id,
            kind: "existing",
          },
    evidence,
    reading,
    workspace,
  });
  // The new face's empty font arrived through the proposal, not an import.
  await open.keepSources();
  const completion =
    recorded &&
    proposeInferred(
      workspace,
      proposal,
      await completeLetters(
        {
          recorded: recordedFor(
            photographRuns(await listRecorded(recorded)).entries,
            evidence.fileName
          ),
          strategy: "recorded-run",
        },
        { evidence, proposal, reading },
        { ...running, runs: recorded }
      )
    );
  return {
    faceId: proposal.faceId,
    found: reading.readings.length,
    inferred: (completion?.candidates ?? []).map((candidate) => ({
      id: candidate.id,
      model: completion?.record.model,
      recorded: completion?.record.recorded ?? false,
      text: textOf(candidate.characters),
    })),
    modelOutput: completion?.modelOutput,
    observed: proposal.letters.map(({ candidate, character, fit }) => ({
      fit,
      id: candidate.id,
      text: textOf([character]),
    })),
  };
};
