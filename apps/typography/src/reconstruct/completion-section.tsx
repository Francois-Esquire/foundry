import { type ChangeEvent, useCallback, useEffect, useMemo } from "react";
import type { RunRecord } from "~/generation/pipeline/run";
import type { StrategyKind } from "~/generation/strategies/strategy";
import type { TypefaceProject } from "~/typeface/project";
import { Button } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { ProgressLine } from "~/ui/controls/progress-line";
import { SecretField } from "~/ui/controls/secret-field";
import { Segmented } from "~/ui/controls/segmented";
import { Select } from "~/ui/controls/select";
import { TextField } from "~/ui/controls/text-field";
import { type BoardEntry, CandidateBoard } from "./candidate-board";
import {
  type RecordedCompletion,
  recordedAvailability,
  recordedLabel,
  type StrategyOption,
  strategyName,
} from "./completion";
import { missingFromAlphabet } from "./considered-characters";
import type { Evidence } from "./core";
import { useCandidateStatuses, useDecisions } from "./destination-section";
import {
  type Completion,
  chosenRecorded,
  type Proposal,
  type ReconstructSession,
  type ReconstructState,
} from "./session";

const count = (amount: number, noun: string) =>
  `${amount} ${noun}${amount === 1 ? "" : "s"}`;

const dayOf = (time: string) => time.slice(0, 10);

/** What drew the letters, and whether live or replayed. Recorded output is always called recorded. */
const madeBy = (record: RunRecord): string => {
  const by = record.model
    ? `${strategyName(record.producedBy).toLowerCase()} strategy with ${record.model}`
    : `${strategyName(record.producedBy).toLowerCase()} strategy`;
  if (record.recorded) {
    return `Replayed from a recorded run of the ${by}, made on ${dayOf(record.createdAt)}. Not live model output.`;
  }
  return record.model
    ? `Drawn now by the ${by}.`
    : `Built by the ${by} on this machine. No model was called.`;
};

/** The same, short enough to print under every letter. */
const sourceNote = (record: RunRecord): string => {
  if (record.recorded) {
    return "From a recorded run. Not live model output.";
  }
  return record.model ? "Drawn now by a model." : "Built by rule. No model.";
};

const lettersOf = (characters: readonly number[]) =>
  characters.map((character) => String.fromCodePoint(character)).join(" ");

interface RecordedChoiceProps {
  readonly evidence: Evidence;
  readonly session: ReconstructSession;
  readonly state: ReconstructState;
}

/** The recorded run that would be replayed, and which photograph it answers for. */
function RecordedChoice({ evidence, session, state }: RecordedChoiceProps) {
  const { catalogue } = state;
  const entry = chosenRecorded(state);
  const choose = useCallback(
    (recordedId: string) => session.updateCompletionDraft({ recordedId }),
    [session]
  );
  if (catalogue.status === "failed") {
    return (
      <Notice tone="problem">
        The recorded runs could not be listed. {catalogue.reason} Check that the
        app is still being served, then reload the page.
      </Notice>
    );
  }
  if (catalogue.status !== "listed") {
    return <ProgressLine label="Listing the recorded runs" />;
  }
  if (!entry) {
    return <p>No recorded run was made for a photograph.</p>;
  }
  const { entries, problems } = catalogue.catalogue;
  return (
    <div className="ty-reconstruct-stack">
      {entries.length > 1 ? (
        <Select
          label="Recorded run"
          onChange={choose}
          options={entries.map((listed: RecordedCompletion) => ({
            label: recordedLabel(listed),
            value: listed.id,
          }))}
          value={entry.id}
        />
      ) : null}
      <p className="ty-lede">
        {recordedLabel(entry)}, recorded on {dayOf(entry.createdAt)} for{" "}
        {entry.evidenceFile}. It drew {entry.targets.join(" ")}.
        {entry.evidenceFile === evidence.fileName
          ? " Those are the characters a replay asks for."
          : ""}
      </p>
      {problems.map((problem) => (
        <Notice key={problem}>{problem}</Notice>
      ))}
    </div>
  );
}

interface ResultProps {
  readonly completion: Completion;
  readonly project: TypefaceProject;
  readonly proposal: Proposal;
  readonly session: ReconstructSession;
}

/** What a strategy answered: the inferred letters, what it left undrawn, and their width. */
function CompletionResult({
  completion,
  project,
  proposal,
  session,
}: ResultProps) {
  const statuses = useCandidateStatuses(project);
  const { accept, acceptAll, reject } = useDecisions();
  const { candidates, inference, narrowedBy, proposed, record } = completion;
  const made = madeBy(record);
  const note = sourceNote(record);
  const entries = useMemo(
    () => candidates.map((candidate): BoardEntry => ({ candidate, note })),
    [candidates, note]
  );
  const waiting = candidates
    .map((candidate) => candidate.id)
    .filter((id) => statuses.get(id) === "proposed");
  const acceptWaiting = useCallback(
    () => acceptAll(waiting),
    [acceptAll, waiting]
  );
  const narrow = useCallback(() => session.narrow(), [session]);
  const propose = useCallback(() => session.proposeInferred(), [session]);
  const { basis, ratio } = inference.widths;
  const reasons = [...new Set(record.unmade.map((unmade) => unmade.reason))];

  return (
    <CandidateBoard
      entries={entries}
      label="Inferred letters"
      metrics={proposal.metrics}
      onAccept={accept}
      onReject={reject}
      statuses={statuses}
    >
      <p
        className="ty-lede"
        data-inferred={candidates.length}
        data-recorded={record.recorded}
      >
        {count(candidates.length, "letter")} inferred of{" "}
        {completion.wanted.length} asked for. {made} None of them was seen in
        the photograph.
      </p>
      {record.unmade.length > 0 ? (
        <Notice>
          {count(record.unmade.length, "character")} not drawn.{" "}
          {reasons.join(" ")}
        </Notice>
      ) : null}
      {inference.alreadyObserved.length > 0 ? (
        <p>
          Left alone because the photograph shows them:{" "}
          {lettersOf(inference.alreadyObserved)}.
        </p>
      ) : null}
      {candidates.length > 0 && ratio > 0 ? (
        <div className="ty-reconstruct-actions">
          <p>
            {narrowedBy === undefined
              ? `The inferred letters are ${ratio.toFixed(2)} times as wide as the observed ones, measured ${
                  basis === "reference-face"
                    ? "letter for letter against the nearest face"
                    : "by plain width over height, which also depends on which letters each set holds"
                }.`
              : `Stretched across by ${narrowedBy.toFixed(2)} to the width of the observed letters. Upright strokes changed by the same factor.`}
          </p>
          <Button
            disabled={proposed || narrowedBy !== undefined || ratio === 1}
            onClick={narrow}
          >
            Fit their width to the observed letters
          </Button>
        </div>
      ) : null}
      {candidates.length > 0 ? (
        <div className="ty-reconstruct-actions">
          {proposed && waiting.length > 0 ? (
            <Button onClick={acceptWaiting} symbol="check" variant="solid">
              Accept all {count(waiting.length, "proposed inferred letter")}
            </Button>
          ) : null}
          {proposed ? null : (
            <Button onClick={propose} symbol="add" variant="solid">
              Propose {count(candidates.length, "inferred letter")} as
              candidates
            </Button>
          )}
        </div>
      ) : null}
    </CandidateBoard>
  );
}

const KINDS: readonly StrategyKind[] = [
  "procedural",
  "recorded-run",
  "vector-model",
  "image-model",
];

interface CompletionSectionProps {
  readonly evidence: Evidence;
  readonly project: TypefaceProject;
  readonly proposal: Proposal;
  readonly session: ReconstructSession;
  readonly state: ReconstructState;
}

/** Asking a generation strategy for the characters the photograph does not show. */
export function CompletionSection({
  evidence,
  project,
  proposal,
  session,
  state,
}: CompletionSectionProps) {
  const { completionDraft: draft } = state;
  useEffect(() => {
    session.listRecorded();
  }, [session]);

  const recorded = chosenRecorded(state);
  const options = useMemo(
    () =>
      session.strategyOptions(
        draft.providerKey,
        recordedAvailability(recorded, evidence.fileName)
      ),
    [draft.providerKey, evidence.fileName, recorded, session]
  );
  const chosen: StrategyOption | undefined = options.find(
    (option) => option.kind === draft.strategy
  );
  const usual = missingFromAlphabet(
    proposal.letters.map((letter) => letter.character)
  );

  const setStrategy = useCallback(
    (strategy: StrategyKind) => session.updateCompletionDraft({ strategy }),
    [session]
  );
  const setWanted = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      session.updateCompletionDraft({ wanted: event.currentTarget.value }),
    [session]
  );
  const setKey = useCallback(
    (providerKey: string) => session.updateCompletionDraft({ providerKey }),
    [session]
  );
  const complete = useCallback(() => session.complete(), [session]);
  const stop = useCallback(() => session.stop(), [session]);
  const model =
    draft.strategy === "image-model" || draft.strategy === "vector-model";

  return (
    <div className="ty-reconstruct-stack">
      <Segmented
        disabled={state.completing}
        label="Generation strategy"
        onChange={setStrategy}
        options={KINDS.map((kind) => ({
          label: strategyName(kind),
          value: kind,
        }))}
        value={draft.strategy}
      />
      {chosen ? (
        <p className="ty-lede">
          {chosen.summary}
          {chosen.model ? ` Model: ${chosen.model}.` : ""}
        </p>
      ) : null}
      {draft.strategy === "recorded-run" ? (
        <RecordedChoice evidence={evidence} session={session} state={state} />
      ) : (
        <TextField
          disabled={state.completing}
          hint={`Leave empty to ask for the rest of the basic alphabet: ${usual}.`}
          label="Characters to infer"
          onChange={setWanted}
          spellCheck={false}
          value={draft.wanted}
        />
      )}
      {model ? (
        <SecretField
          hint="Kept in memory for this page only. It is sent to fal with the request and nowhere else."
          label="fal API key"
          onChange={setKey}
          value={draft.providerKey}
        />
      ) : null}
      {chosen && !chosen.availability.available ? (
        <Notice>Cannot run now. {chosen.availability.reason}</Notice>
      ) : null}
      <div className="ty-reconstruct-actions">
        <Button
          disabled={state.completing || !chosen?.availability.available}
          onClick={complete}
          variant="solid"
        >
          Infer the missing characters
        </Button>
        {state.completing ? <Button onClick={stop}>Stop</Button> : null}
      </div>
      {state.completing ? (
        <ProgressLine label="Inferring the missing characters" />
      ) : null}
      {state.completionProblem ? (
        <Notice tone="problem">{state.completionProblem}</Notice>
      ) : null}
      {state.completion ? (
        <CompletionResult
          completion={state.completion}
          project={project}
          proposal={proposal}
          session={session}
        />
      ) : null}
    </div>
  );
}
