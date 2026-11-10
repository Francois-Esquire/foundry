import { useCallback } from "react";
import type { FaceMetrics } from "~/typeface/face";
import type { Candidate } from "~/typeface/project";
import { isUnconfirmed } from "~/typeface/provenance";
import { codePointName } from "~/ui/content/code-point";
import { Button } from "~/ui/controls/button";
import { Mark } from "~/ui/symbols/mark";
import { GlyphDrawing } from "./glyph-drawing";
import { provenanceMark, provenanceNote } from "./provenance-notes";

const DRAWING_HEIGHT = 96;

const counted = (count: number, word: string) => `${count} ${word}`;

interface CandidateRowProps {
  readonly candidate: Candidate;
  readonly metrics: FaceMetrics;
  readonly onAccept: (candidate: Candidate) => void;
  readonly onReject: (candidate: Candidate) => void;
}

function CandidateRow({
  candidate,
  metrics,
  onAccept,
  onReject,
}: CandidateRowProps) {
  const accept = useCallback(() => onAccept(candidate), [candidate, onAccept]);
  const reject = useCallback(() => onReject(candidate), [candidate, onReject]);
  const characters = candidate.characters.map(codePointName).join(" ");
  return (
    <li>
      <div
        className="ty-studio-candidate-frame"
        data-unconfirmed={isUnconfirmed(candidate.provenance)}
      >
        <GlyphDrawing
          advance={candidate.advance}
          height={DRAWING_HEIGHT}
          metrics={metrics}
          outline={candidate.outline}
          tone="carbon"
        />
      </div>
      <div className="ty-studio-candidate-text">
        <span className="ty-label">
          {candidate.name}
          {characters ? `, ${characters}` : ""}
        </span>
        <Mark kind={provenanceMark(candidate.provenance)}>
          {isUnconfirmed(candidate.provenance)
            ? "Not accepted"
            : "Proposed, not accepted"}
        </Mark>
        <p>
          {provenanceNote(candidate.provenance)}{" "}
          {candidate.replaces
            ? "Accepting it redraws a glyph the face already has."
            : "Accepting it adds a glyph to the face."}
        </p>
        <div className="ty-studio-row">
          <Button onClick={accept} symbol="check" variant="solid">
            Accept {candidate.name}
          </Button>
          <Button onClick={reject} symbol="close">
            Reject {candidate.name}
          </Button>
        </div>
      </div>
    </li>
  );
}

interface CandidatesPanelProps {
  /** Every candidate for the face, settled ones included. */
  readonly candidates: readonly Candidate[];
  readonly metrics: FaceMetrics;
  readonly onAccept: (candidate: Candidate) => void;
  readonly onReject: (candidate: Candidate) => void;
}

/**
 * Proposed glyph designs for the face, each with where it came from. A
 * candidate stays out of the face until it is accepted; accepting it opens
 * it in the editor like any glyph.
 */
export function CandidatesPanel({
  candidates,
  metrics,
  onAccept,
  onReject,
}: CandidatesPanelProps) {
  const proposed = candidates.filter(
    (candidate) => candidate.status === "proposed"
  );
  const accepted = candidates.filter(
    (candidate) => candidate.status === "accepted"
  ).length;
  const rejected = candidates.length - proposed.length - accepted;
  return (
    <div className="ty-studio-candidates">
      {proposed.length === 0 ? (
        <p className="ty-lede">
          No candidates are waiting for this face. Designs proposed in Generate
          and Reconstruct appear here to be accepted or rejected.
        </p>
      ) : (
        <ul>
          {proposed.map((candidate) => (
            <CandidateRow
              candidate={candidate}
              key={candidate.id}
              metrics={metrics}
              onAccept={onAccept}
              onReject={onReject}
            />
          ))}
        </ul>
      )}
      {accepted + rejected > 0 ? (
        <p className="ty-label">
          {counted(accepted, "accepted")}, {counted(rejected, "rejected")}
        </p>
      ) : null}
    </div>
  );
}
