/**
 * The generate command: the Generate place's operations, in the order a
 * person takes them there. A script extension waits whole until it is
 * accepted. Single characters are proposed as candidates.
 */
import {
  performRun,
  prepareRun,
  proposeRun,
  type RunRequest,
} from "~/generate/running";
import {
  extendFace,
  offeredSheets,
} from "~/generate/script-extension/extending";
import type { RunRecord } from "~/generation/pipeline/run";
import {
  listRecorded,
  type RecordedCatalogue,
  type RecordedEntry,
} from "~/generation/strategies/recorded/catalogue";
import { outputLabel } from "~/generation/strategies/recorded/manifest";
import type { FilesRun } from "~/generation/strategies/recorded/source";
import { analyseStyle } from "~/generation/style/reference";
import { Refusal } from "~/lib/refusal";
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

const sourceOf = (record: RunRecord): RunSource => ({
  model: record.model,
  recorded: record.recorded,
  strategy: record.producedBy,
});

export const generateExtension = async (
  open: OpenProject,
  request: ExtensionRunRequest
): Promise<ExtensionRun> => {
  const { means, store, workspace } = open;
  const plan = EXTENSION_PLANS[request.plan];
  if (!plan) {
    throw new Refusal(
      `There is no script extension plan named ${request.plan}. The plans are: ${Object.keys(EXTENSION_PLANS).join(", ")}.`
    );
  }
  const face = faceNamed(workspace.getState().project, request.faceId);
  const recorded = await means.runAt(request.recordedRun);
  const sheets = await offeredSheets(recorded, {
    plan,
    recordedRun: recorded.name,
  });
  const { extension, id: runId } = await extendFace(face.id, plan, sheets, {
    clock: means.clock,
    codec: means.codec,
    newId: means.newId,
    runs: recorded,
    workspace,
  });
  const [first] = extension.runs;
  if (!first) {
    throw new Error(
      `No sheet of ${recorded.name} was run, though it has some.`
    );
  }
  const modelOutput = await store.keepWaitingRun(
    recorded.name,
    recorded.files,
    extension.changes
  );
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
  { entries, problems }: RecordedCatalogue,
  name: string,
  output: string | undefined
): RecordedEntry => {
  const labels = entries.map((entry) => outputLabel(entry.output));
  const [only] = entries;
  if (!only) {
    throw new Refusal(
      problems.join(" ") || `The recorded run ${name} lists no output.`
    );
  }
  if (output === undefined) {
    if (entries.length === 1) {
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

/** Prepares, performs and proposes one run, and keeps what a model made for it. */
const candidateRun = async (
  open: OpenProject,
  asked: RunRequest,
  entries: readonly RecordedEntry[],
  recorded?: FilesRun
): Promise<CandidateRun> => {
  const { means, places, store, workspace } = open;
  const runMeans = {
    clock: means.clock,
    codec: means.codec,
    modelFetch: means.modelFetch,
    newId: means.newId,
    providerKey: places.providerKey.getState,
    runs: recorded ?? means.servedRuns,
    workspace,
  };
  const prepared = await prepareRun(asked, entries, runMeans);
  const run = await performRun(
    prepared,
    analyseStyle(workspace.openFace(asked.faceId)),
    runMeans
  );
  const candidates = proposeRun(workspace, prepared, run);
  const output = recorded?.files ?? modelOutputFiles(run, prepared.targets);
  const modelOutput =
    output &&
    (await store.keepModelOutput(recorded?.name ?? run.record.runId, output));
  open.keep({
    verdicts: {
      ...open.kept().verdicts,
      ...Object.fromEntries(
        candidates.map(({ candidate, evaluation }) => [
          candidate.id,
          evaluation.verdict,
        ])
      ),
    },
  });
  const names = new Map(prepared.targets.map((target) => [target.key, target]));
  return {
    candidates: candidates.map(({ candidate, evaluation, target }) => ({
      id: candidate.id,
      name: candidate.name,
      text: target.text,
      verdict: evaluation.verdict,
    })),
    modelOutput,
    runId: means.newId(),
    source: sourceOf(run.record),
    unmade: run.record.unmade.map(({ key, reason }) => ({
      name: names.get(key)?.name ?? key,
      reason,
    })),
  };
};

export const generateCandidates = async (
  open: OpenProject,
  request: CandidateRunRequest
): Promise<CandidateRun> => {
  const { id: faceId } = faceNamed(
    open.workspace.getState().project,
    request.faceId
  );
  if (request.kind === "characters") {
    return candidateRun(
      open,
      {
        characters: readTypedCharacters(request.characters),
        faceId,
        kind: "characters",
        strategy: request.strategy,
      },
      []
    );
  }
  const recorded = await open.means.runAt(request.recordedRun);
  const catalogue = await listRecorded(recorded);
  const { id: entryId } = chosenEntry(catalogue, recorded.name, request.output);
  return candidateRun(
    open,
    { entryId, faceId, kind: "recorded" },
    catalogue.entries,
    recorded
  );
};
