import { useCallback } from "react";
import { formatCodePoint } from "~/lib/code-point";
import { studioHash } from "~/studio/studio-address";
import { addedGlyph } from "~/typeface/changes";
import type { FaceMetrics } from "~/typeface/face";
import type { CandidateStatus } from "~/typeface/project";
import {
  designFrame,
  designMark,
  type Provenance,
} from "~/typeface/provenance";
import { DesignFrame } from "~/ui/content/design-frame";
import { Button, ButtonLink } from "~/ui/controls/button";
import { Mark } from "~/ui/symbols/mark";
import { EvaluationPanel } from "./evaluation-panel";
import { GlyphFigure } from "./glyph-figure";
import { provenanceFacts } from "./provenance-facts";
import type { ReviewedCandidate } from "./running";

interface CandidateCellProps {
  /** True while a run is under way, when nothing can be regenerated. */
  readonly busy: boolean;
  readonly metrics: FaceMetrics;
  /** Why the glyph was not compared with the face's own, when it was not. */
  readonly notCompared: string;
  readonly onAccept: (candidateId: string) => void;
  readonly onRegenerate: (key: string) => void;
  readonly onReject: (candidateId: string) => void;
  readonly reviewed: ReviewedCandidate;
  /** The candidate's standing in the project now. Undefined once it has left the project. */
  readonly status: CandidateStatus | undefined;
}

/** The last character the interface's own type is sure to draw. */
const LAST_INTERFACE_CHARACTER = 0x02_4f;
const FIRST_VISIBLE_CHARACTER = 0x21;

/**
 * The character a target draws, when the interface's own type can print it.
 * Anything else is named by its code point, so no system fallback font ever
 * stands in for a letterform.
 */
const literalOf = ({ target }: ReviewedCandidate): string | undefined => {
  const [character, ...others] = target.characters;
  return character !== undefined &&
    others.length === 0 &&
    character >= FIRST_VISIBLE_CHARACTER &&
    character <= LAST_INTERFACE_CHARACTER
    ? target.text
    : undefined;
};

/** What to call the glyph in a control: its character, else its code point, else its glyph name. */
const spokenName = (reviewed: ReviewedCandidate): string => {
  const [character] = reviewed.target.characters;
  return (
    literalOf(reviewed) ??
    (character === undefined
      ? reviewed.target.name
      : formatCodePoint(character))
  );
};

function Standing({
  provenance,
  status,
}: {
  readonly provenance: Provenance;
  readonly status: CandidateStatus | undefined;
}) {
  if (status === "proposed") {
    return (
      <Mark kind={designMark(provenance, status)}>Proposed, not accepted</Mark>
    );
  }
  if (status === "accepted") {
    return <Mark kind="revisions">Accepted, in the face as a revision</Mark>;
  }
  return (
    <span className="ty-generate-standing">
      {status === "rejected"
        ? "Rejected. It stays out of the face."
        : "No longer in the project."}
    </span>
  );
}

/**
 * The frame of a candidate on a Generate board. Every candidate here was
 * proposed, so one with no status has left the project: like a rejected one
 * it is neither in the face nor waiting, and gets a hairline.
 */
export const frameMark = (
  provenance: Provenance,
  status: CandidateStatus | undefined
) => (status === undefined ? "none" : designFrame(provenance, status));

/**
 * One candidate on the board: drawn large in the dotted carbon frame while
 * it waits for a decision and the solid one once it is in the face, with
 * where it came from, how it was judged, and the decisions a person can make
 * about it.
 */
export function CandidateCell({
  busy,
  metrics,
  notCompared,
  onAccept,
  onRegenerate,
  onReject,
  reviewed,
  status,
}: CandidateCellProps) {
  const { attempt, candidate, holdout, record, target } = reviewed;
  const name = spokenName(reviewed);
  // Labels are printed in capitals, which would turn g into G. The
  // character itself is printed as it is, inside one span with its verb so
  // a button lays the words out as one piece of text.
  const shown = <span className="ty-generate-literal">{name}</span>;
  const accept = useCallback(
    () => onAccept(candidate.id),
    [candidate.id, onAccept]
  );
  const reject = useCallback(
    () => onReject(candidate.id),
    [candidate.id, onReject]
  );
  const regenerate = useCallback(
    () => onRegenerate(target.key),
    [onRegenerate, target.key]
  );
  const characters = target.characters.map(formatCodePoint).join(" ");
  return (
    <li
      className="ty-generate-candidate"
      data-candidate={target.key}
      data-status={status ?? "gone"}
    >
      <DesignFrame
        className="ty-generate-frame"
        mark={frameMark(candidate.provenance, status)}
      >
        <GlyphFigure
          advance={candidate.advance}
          holdout={holdout}
          metrics={metrics}
          name={`Candidate for ${name}${holdout ? ", in carbon, under the ink outline of the face's own glyph" : ", in carbon"}`}
          outline={candidate.outline}
        />
      </DesignFrame>
      <div className="ty-generate-candidate-text">
        <h3 className="ty-label">
          {literalOf(reviewed) ? <>{shown}, </> : null}
          {target.name}
          {characters ? `, ${characters}` : ""}
          {attempt > 1 ? `, attempt ${attempt}` : ""}
        </h3>
        <Standing provenance={candidate.provenance} status={status} />
        <p>
          {candidate.replaces
            ? "Accepting it redraws a glyph the face already has."
            : "Accepting it adds a glyph to the face."}
        </p>
        <dl className="ty-generate-facts">
          {provenanceFacts(candidate.provenance, record).map((fact) => (
            <div key={fact.label}>
              <dt className="ty-label">{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
        <div className="ty-generate-actions">
          {status === "proposed" ? (
            <>
              <Button onClick={accept} symbol="check" variant="solid">
                <span>Accept {shown}</span>
              </Button>
              <Button onClick={reject} symbol="close">
                <span>Reject {shown}</span>
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
              <span>Open {shown} in the Studio</span>
            </ButtonLink>
          ) : (
            <Button disabled={busy} onClick={regenerate}>
              <span>Regenerate {shown}</span>
            </Button>
          )}
        </div>
      </div>
      <EvaluationPanel notCompared={notCompared} reviewed={reviewed} />
    </li>
  );
}
