import { type ReactNode, useCallback } from "react";
import type { NewCandidate } from "~/generation/pipeline/stages";
import { studioHash } from "~/studio/studio-address";
import { addedGlyph } from "~/typeface/changes";
import type { CandidateStatus } from "~/typeface/project";
import { isUnconfirmed } from "~/typeface/provenance";
import { codePointName } from "~/ui/content/code-point";
import { Button, ButtonLink } from "~/ui/controls/button";
import { Mark } from "~/ui/symbols/mark";
import type { RecoveryMetrics } from "./core";
import { OutlineFigure } from "./outline-figure";

/** A candidate on the board, with what the screen knows about it beyond its outline. */
export interface BoardEntry {
  readonly candidate: NewCandidate;
  /** A fact to print under the name, such as the fit score. */
  readonly note?: string;
}

/** What to call a candidate in a control: its character when it has one, else its glyph name. */
const spokenName = ({ characters, name }: NewCandidate) => {
  const [character] = characters;
  return character === undefined ? name : String.fromCodePoint(character);
};

const basisOf = ({ provenance }: NewCandidate) =>
  provenance.origin === "reconstructed" && provenance.basis === "observed"
    ? "observed"
    : "inferred";

function Standing({
  status,
}: {
  readonly status: CandidateStatus | undefined;
}) {
  if (status === "accepted") {
    return <Mark kind="revisions">Accepted, in the face as a revision</Mark>;
  }
  if (status === "rejected") {
    return <span>Rejected. It stays out of the face.</span>;
  }
  return (
    <span>
      {status === "proposed" ? "Proposed, not accepted." : "Not proposed yet."}
    </span>
  );
}

interface BoardCellProps {
  readonly entry: BoardEntry;
  readonly metrics: RecoveryMetrics;
  readonly onAccept: (candidateId: string) => void;
  readonly onReject: (candidateId: string) => void;
  /** The candidate's standing in the project. Undefined before it is proposed. */
  readonly status: CandidateStatus | undefined;
}

function BoardCell({
  entry,
  metrics,
  onAccept,
  onReject,
  status,
}: BoardCellProps) {
  const { candidate, note } = entry;
  const name = spokenName(candidate);
  const basis = basisOf(candidate);
  const accept = useCallback(
    () => onAccept(candidate.id),
    [candidate.id, onAccept]
  );
  const reject = useCallback(
    () => onReject(candidate.id),
    [candidate.id, onReject]
  );
  return (
    <li
      className="ty-reconstruct-candidate"
      data-basis={basis}
      data-character={name}
      data-status={status ?? "unproposed"}
    >
      <div
        className="ty-reconstruct-frame"
        data-unconfirmed={
          isUnconfirmed(candidate.provenance) && status !== "accepted"
        }
      >
        <OutlineFigure
          advance={candidate.advance}
          metrics={metrics}
          name={`Candidate for ${name}, in carbon`}
          outline={candidate.outline}
        />
      </div>
      <div className="ty-reconstruct-candidate-text">
        <h4 className="ty-label">
          {name}, {candidate.characters.map(codePointName).join(" ")}
        </h4>
        {basis === "observed" ? (
          <Mark kind="edited">Observed in the photograph</Mark>
        ) : (
          <Mark kind="unconfirmed">Inferred, not in the photograph</Mark>
        )}
        <Standing status={status} />
        {note ? <span>{note}</span> : null}
        <span className="ty-reconstruct-small">
          {candidate.replaces
            ? "Accepting it redraws a glyph the face already has."
            : "Accepting it adds a glyph to the face."}
        </span>
        <div className="ty-reconstruct-actions">
          {status === "proposed" ? (
            <>
              <Button onClick={accept} symbol="check" variant="solid">
                Accept {name}
              </Button>
              <Button onClick={reject} symbol="close">
                Reject {name}
              </Button>
            </>
          ) : null}
          {status === "accepted" ? (
            <ButtonLink
              href={studioHash(
                candidate.faceId,
                candidate.replaces ?? addedGlyph(candidate.id)
              )}
            >
              Open {name} in the Studio
            </ButtonLink>
          ) : null}
        </div>
      </div>
    </li>
  );
}

interface CandidateBoardProps {
  /** Printed above the board, with any actions that concern all of it. */
  readonly children?: ReactNode;
  readonly entries: readonly BoardEntry[];
  /** Names the board for assistive technology. */
  readonly label: string;
  readonly metrics: RecoveryMetrics;
  readonly onAccept: (candidateId: string) => void;
  readonly onReject: (candidateId: string) => void;
  /** Each candidate's standing in the project, by id. */
  readonly statuses: ReadonlyMap<string, CandidateStatus>;
}

/**
 * Candidates from one reconstruction. Each says whether it was observed or
 * inferred: an observed letter carries the solid mark, an inferred one the
 * dotted mark, and its frame stays dotted until it is accepted.
 */
export function CandidateBoard({
  children,
  entries,
  label,
  metrics,
  onAccept,
  onReject,
  statuses,
}: CandidateBoardProps) {
  return (
    <div className="ty-reconstruct-stack">
      {children}
      <ul aria-label={label} className="ty-reconstruct-board">
        {entries.map((entry) => (
          <BoardCell
            entry={entry}
            key={entry.candidate.id}
            metrics={metrics}
            onAccept={onAccept}
            onReject={onReject}
            status={statuses.get(entry.candidate.id)}
          />
        ))}
      </ul>
    </div>
  );
}
