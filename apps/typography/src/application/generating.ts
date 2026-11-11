/**
 * The generate command. It drives the Generate place's own sessions: the
 * script extension's, whose result waits whole, and the candidates' one,
 * whose result is proposed. Neither session rejects, so what a session's
 * state says afterwards is read here and a failure is thrown as a refusal.
 */
import type { RecordedEntry } from "~/generate/recorded-catalogue";
import { faceStanding } from "~/generate/script-extension/face-standing";
import { faceStateOf } from "~/generate/script-extension/session";
import type { GenerateSession, ReviewedRun } from "~/generate/session";
import type { RunRecord } from "~/generation/pipeline/run";
import { outputLabel } from "~/generation/strategies/recorded/manifest";
import { readTypedCharacters } from "~/unicode/typed-characters";
import type {
  CandidateRun,
  CandidateRunRequest,
  ExtensionRun,
  ExtensionRunRequest,
  RunSource,
} from "./commands";
import { EXTENSION_PLANS } from "./extension-plans";
import { faceNamed } from "./faces";
import { modelOutputFiles } from "./model-output";
import type { OpenProject } from "./open-project";
import { Refusal } from "./refusal";
import { NO_RECORDED_RUNS, runName, servedRun } from "./served-run";

const sourceOf = (record: RunRecord): RunSource => ({
  model: record.model,
  recorded: record.recorded,
  strategy: record.producedBy,
});

export const generateExtension = async (
  open: OpenProject,
  request: ExtensionRunRequest
): Promise<ExtensionRun> => {
  const { means, places, store, workspace } = open;
  const plan = EXTENSION_PLANS[request.plan];
  if (!plan) {
    throw new Refusal(
      `There is no script extension plan named ${request.plan}. The plans are: ${Object.keys(EXTENSION_PLANS).join(", ")}.`
    );
  }
  const face = faceNamed(workspace.getState().project, request.faceId);
  const source = workspace.openFace(face.id);
  const standing = faceStanding({
    face,
    inSource: (character) => source.glyphForCharacter(character) !== undefined,
    plan,
    working: workspace.workingFace(face.id),
  });
  if (standing.kind === "not-offered") {
    throw new Refusal(standing.reason);
  }
  const files = await means.readRecordedRun(request.recordedRun);
  const name = runName(request.recordedRun);
  const session = places.scriptExtension(
    { plan, recordedRun: name },
    servedRun(name, files)
  );
  await session.listSource();
  const listed = session.getState().source;
  if (listed.status !== "listed") {
    throw new Refusal(
      listed.status === "failed"
        ? listed.reason
        : `The recorded run ${name} could not be listed.`
    );
  }
  await session.run(face.id);
  const { run } = faceStateOf(session.getState(), face.id);
  if (run.status !== "finished") {
    throw new Refusal(
      run.status === "failed"
        ? run.reason
        : `The ${plan.script} subset was not made for this face: the run did not start.`
    );
  }
  const { extension } = run;
  const [first] = extension.runs;
  if (!first) {
    throw new Refusal(`The recorded run ${name} holds no sheet to replay.`);
  }
  const modelOutput = await store.keepWaitingRun(
    name,
    files,
    extension.changes
  );
  const runId = means.newId();
  open.keep({
    waitingRuns: [
      ...open.kept().waitingRuns,
      {
        faceId: face.id,
        glyphs: extension.glyphs.length,
        modelOutput,
        runId,
        script: plan.script,
      },
    ],
  });
  return {
    glyphs: extension.glyphs.map(({ evaluation, planned }) => ({
      name: planned.name,
      text: String.fromCodePoint(...planned.characters),
      verdict: evaluation?.verdict,
    })),
    modelOutput,
    runId,
    source: sourceOf(first.record),
    unmade: extension.missing,
  };
};

/** The one output of a recorded run a command means. */
const chosenEntry = (
  entries: readonly RecordedEntry[],
  name: string,
  output: string | undefined
): RecordedEntry => {
  const labels = entries.map((entry) => outputLabel(entry.output));
  const [only] = entries;
  if (output === undefined) {
    if (only && entries.length === 1) {
      return only;
    }
    throw new Refusal(
      `The recorded run ${name} has ${entries.length} outputs: ${labels.join(", ")}. Name the one to replay.`
    );
  }
  const chosen = entries.find((entry) => outputLabel(entry.output) === output);
  if (!chosen) {
    throw new Refusal(
      `The recorded run ${name} has no output named ${output}. Its outputs are: ${labels.join(", ")}.`
    );
  }
  return chosen;
};

/** Replays one output of a recorded run and answers with the session it ran in. */
const replay = async (
  open: OpenProject,
  request: CandidateRunRequest & { readonly kind: "recorded" },
  faceId: string,
  files: ReadonlyMap<string, Uint8Array>
): Promise<GenerateSession> => {
  const name = runName(request.recordedRun);
  const session = open.places.generate(servedRun(name, files));
  await session.listRecorded();
  const { catalogue } = session.getState();
  if (catalogue.status !== "listed") {
    throw new Refusal(
      catalogue.status === "failed"
        ? catalogue.reason
        : `The recorded run ${name} could not be listed.`
    );
  }
  const { entries, problems } = catalogue.catalogue;
  if (entries.length === 0) {
    throw new Refusal(
      problems.join(" ") || `The recorded run ${name} lists no output.`
    );
  }
  const entry = chosenEntry(entries, name, request.output);
  await session.run({ entryId: entry.id, faceId, kind: "recorded" });
  return session;
};

/** The run a session just finished, or a refusal with the reason it gave. */
const finished = (session: GenerateSession): ReviewedRun => {
  const {
    activity,
    runs: [made],
  } = session.getState();
  if (activity?.status !== "finished" || !made) {
    throw new Refusal(
      activity?.failure?.reason ?? "The run did not start. Try it again."
    );
  }
  return made;
};

export const generateCandidates = async (
  open: OpenProject,
  request: CandidateRunRequest
): Promise<CandidateRun> => {
  const { means, places, store, workspace } = open;
  const face = faceNamed(workspace.getState().project, request.faceId);
  let session: GenerateSession;
  let output: ReadonlyMap<string, Uint8Array> | undefined;
  if (request.kind === "recorded") {
    output = await means.readRecordedRun(request.recordedRun);
    session = await replay(open, request, face.id, output);
  } else {
    session = places.generate(NO_RECORDED_RUNS);
    await session.run({
      characters: readTypedCharacters(request.characters),
      faceId: face.id,
      kind: "characters",
      strategy: request.strategy,
    });
  }
  const made = finished(session);
  output ??= modelOutputFiles(made);
  const modelOutput =
    output &&
    (await store.keepModelOutput(
      request.kind === "recorded"
        ? runName(request.recordedRun)
        : made.record.runId,
      output
    ));
  open.keep({
    verdicts: {
      ...open.kept().verdicts,
      ...Object.fromEntries(
        made.candidates.map(({ candidate, evaluation }) => [
          candidate.id,
          evaluation.verdict,
        ])
      ),
    },
  });
  const names = new Map(made.targets.map((target) => [target.key, target]));
  return {
    candidates: made.candidates.map(({ candidate, evaluation, target }) => ({
      id: candidate.id,
      name: candidate.name,
      text: target.text,
      verdict: evaluation.verdict,
    })),
    modelOutput,
    runId: made.id,
    source: sourceOf(made.record),
    unmade: made.record.unmade.map(({ key, reason }) => ({
      name: names.get(key)?.name ?? key,
      reason,
    })),
  };
};
