import { type ChangeEvent, useCallback, useMemo } from "react";
import { studioHash } from "~/studio/studio-address";
import { isEditable } from "~/typeface/face";
import type { CandidateStatus, TypefaceProject } from "~/typeface/project";
import { Button, ButtonLink } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { ProgressLine } from "~/ui/controls/progress-line";
import { Segmented } from "~/ui/controls/segmented";
import { Select } from "~/ui/controls/select";
import { TextField } from "~/ui/controls/text-field";
import { Mark } from "~/ui/symbols/mark";
import { useWorkspace } from "~/workspace/react";
import { type BoardEntry, CandidateBoard } from "./candidate-board";
import { type Destination, faceLabel, familyNameFrom } from "./destination";
import type {
  LetterReading,
  Proposal,
  ReconstructSession,
  ReconstructState,
} from "./session";

type DestinationKind = Destination["kind"];

const KINDS: readonly {
  readonly label: string;
  readonly value: DestinationKind;
}[] = [
  { label: "A new face", value: "new" },
  { label: "A face in the project", value: "existing" },
];

const count = (amount: number, noun: string) =>
  `${amount} ${noun}${amount === 1 ? "" : "s"}`;

/** What the two marks mean here, printed once above everything they mark. */
export function BasisLegend() {
  return (
    <div className="ty-reconstruct-actions">
      <Mark kind="edited">Observed: seen in the photograph</Mark>
      <Mark kind="unconfirmed">
        Inferred: not seen in the photograph, drawn to match
      </Mark>
    </div>
  );
}

/** Each candidate's standing by id, read from the project so undo shows at once. */
export const useCandidateStatuses = (
  project: TypefaceProject
): ReadonlyMap<string, CandidateStatus> =>
  useMemo(
    () =>
      new Map(
        project.candidates.map((candidate) => [candidate.id, candidate.status])
      ),
    [project.candidates]
  );

/** Accepting and rejecting through the workspace. A refusal becomes a notice there. */
export const useDecisions = () => {
  const workspace = useWorkspace();
  const accept = useCallback(
    (candidateId: string) => {
      workspace.acceptCandidate(candidateId);
    },
    [workspace]
  );
  const reject = useCallback(
    (candidateId: string) => {
      workspace.rejectCandidate(candidateId);
    },
    [workspace]
  );
  const acceptAll = useCallback(
    (candidateIds: readonly string[]) => {
      for (const candidateId of candidateIds) {
        workspace.acceptCandidate(candidateId);
      }
    },
    [workspace]
  );
  return { accept, acceptAll, reject };
};

interface ChoiceProps {
  readonly project: TypefaceProject;
  readonly reading: LetterReading;
  readonly session: ReconstructSession;
  readonly state: ReconstructState;
}

/** Choosing where the letters go, and proposing them there. */
function DestinationChoice({ project, reading, session, state }: ChoiceProps) {
  const { destination } = state;
  const editable = project.faces.filter(isEditable);
  const letters = reading.recovery.distinct.length;

  const setKind = useCallback(
    (kind: DestinationKind) =>
      session.setDestination(
        kind === "new"
          ? {
              familyName: familyNameFrom(state.evidence?.fileName ?? ""),
              kind,
            }
          : { faceId: editable[0]?.id, kind }
      ),
    [editable, session, state.evidence]
  );
  const setName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      session.setDestination({
        familyName: event.currentTarget.value,
        kind: "new",
      }),
    [session]
  );
  const setFace = useCallback(
    (faceId: string) => session.setDestination({ faceId, kind: "existing" }),
    [session]
  );
  const propose = useCallback(() => session.propose(), [session]);

  return (
    <div className="ty-reconstruct-stack">
      <div className="ty-reconstruct-controls">
        <Segmented
          disabled={state.proposing}
          label="The letters go to"
          onChange={setKind}
          options={KINDS}
          value={destination.kind}
        />
        {destination.kind === "new" ? (
          <TextField
            disabled={state.proposing}
            hint="An empty font is made under this name. The letters arrive on it as candidates."
            label="Family name of the new face"
            onChange={setName}
            value={destination.familyName}
          />
        ) : null}
        {destination.kind === "existing" && editable.length > 0 ? (
          <Select
            disabled={state.proposing}
            label="Face"
            onChange={setFace}
            options={editable.map((face) => ({
              label: faceLabel(face),
              value: face.id,
            }))}
            value={destination.faceId ?? editable[0]?.id ?? ""}
          />
        ) : null}
      </div>
      {destination.kind === "existing" && editable.length === 0 ? (
        <Notice>
          The project has no face that can take letters. Import a font, pin an
          instance of a variable face in the Studio, or make a new face here.
        </Notice>
      ) : null}
      {destination.kind === "existing" && editable.length > 0 ? (
        <p className="ty-lede">
          The letters are scaled to this face's own lines. A character the face
          already draws is proposed as a redrawing of that glyph.
        </p>
      ) : null}
      <div className="ty-reconstruct-actions">
        <Button
          disabled={letters === 0 || state.proposing}
          onClick={propose}
          symbol="add"
          variant="solid"
        >
          Propose {count(letters, "letter")} as candidates
        </Button>
        {letters === 0 ? (
          <span>Label at least one letter to have something to propose.</span>
        ) : null}
      </div>
      {state.proposing ? (
        <ProgressLine
          label={
            destination.kind === "new"
              ? "Making the new face and proposing the letters"
              : "Proposing the letters"
          }
        />
      ) : null}
      {state.proposalProblem ? (
        <Notice tone="problem">{state.proposalProblem}</Notice>
      ) : null}
    </div>
  );
}

interface ProposedProps {
  readonly project: TypefaceProject;
  readonly proposal: Proposal;
  readonly session: ReconstructSession;
}

/** The observed letters as candidates on the chosen face, to accept or reject. */
function ProposedLetters({ project, proposal, session }: ProposedProps) {
  const statuses = useCandidateStatuses(project);
  const { accept, acceptAll, reject } = useDecisions();
  const face = project.faces.find(
    (candidate) => candidate.id === proposal.faceId
  );
  const entries = useMemo(
    () =>
      proposal.letters.map(
        ({ candidate, fit }): BoardEntry => ({
          candidate,
          note: proposal.kept.has(candidate.id)
            ? "Outline from an earlier marking."
            : `Fit ${fit.toFixed(2)}.`,
        })
      ),
    [proposal.kept, proposal.letters]
  );
  const waiting = proposal.letters
    .map(({ candidate }) => candidate.id)
    .filter((id) => statuses.get(id) === "proposed");
  const accepted = proposal.letters.filter(
    ({ candidate }) => statuses.get(candidate.id) === "accepted"
  ).length;
  const acceptWaiting = useCallback(
    () => acceptAll(waiting),
    [acceptAll, waiting]
  );
  const reopen = useCallback(() => session.reopen(), [session]);
  const faceName = face ? faceLabel(face) : "a face that has left the project";
  const revisions = project.revisions
    .slice(0, project.head)
    .filter((revision) =>
      revision.changes.some((change) => change.faceId === proposal.faceId)
    ).length;

  return (
    <CandidateBoard
      entries={entries}
      label="Observed letters"
      metrics={proposal.metrics}
      onAccept={accept}
      onReject={reject}
      statuses={statuses}
    >
      <Notice action={<Button onClick={reopen}>Mark or label again</Button>}>
        {count(proposal.letters.length, "observed letter")} proposed to{" "}
        {faceName}. The region and the labels are held still while they are
        decided.
      </Notice>
      {proposal.kept.size > 0 ? (
        <Notice>
          {count(proposal.kept.size, "letter")} of this photograph{" "}
          {proposal.kept.size === 1 ? "was" : "were"} proposed before from
          another marking. A candidate cannot be withdrawn, so the earlier{" "}
          {proposal.kept.size === 1 ? "outline stands" : "outlines stand"} and
          the new tracing was not proposed. Reject what you do not want.
        </Notice>
      ) : null}
      {proposal.taken > 0 ? (
        <Notice>
          {count(proposal.taken, "letter")} of this photograph{" "}
          {proposal.taken === 1 ? "was" : "were"} already proposed to another
          face and cannot be proposed twice. Decide{" "}
          {proposal.taken === 1 ? "it" : "them"} on that face.
        </Notice>
      ) : null}
      <div className="ty-reconstruct-actions">
        {waiting.length > 0 ? (
          <Button onClick={acceptWaiting} symbol="check" variant="solid">
            Accept all {count(waiting.length, "proposed letter")}
          </Button>
        ) : null}
        {face ? (
          <ButtonLink href={studioHash(face.id)}>
            Open {faceName} in the Studio
          </ButtonLink>
        ) : null}
        <p
          data-accepted={accepted}
          data-face={proposal.faceId}
          data-revisions={revisions}
        >
          {accepted} accepted. {faceName} has {count(revisions, "revision")}.
        </p>
      </div>
    </CandidateBoard>
  );
}

interface DestinationSectionProps {
  readonly project: TypefaceProject;
  readonly reading: LetterReading;
  readonly session: ReconstructSession;
  readonly state: ReconstructState;
}

/** Where the letters go, and the candidates once they are there. */
export function DestinationSection({
  project,
  reading,
  session,
  state,
}: DestinationSectionProps) {
  return state.proposal ? (
    <ProposedLetters
      project={project}
      proposal={state.proposal}
      session={session}
    />
  ) : (
    <DestinationChoice
      project={project}
      reading={reading}
      session={session}
      state={state}
    />
  );
}
