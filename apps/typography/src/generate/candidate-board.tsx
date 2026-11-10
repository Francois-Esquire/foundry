import { useCallback, useMemo } from "react";
import type { CandidateStatus } from "~/typeface/project";
import { Button } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { Select } from "~/ui/controls/select";
import { useWorkspace } from "~/workspace/react";
import { CandidateCell } from "./candidate-cell";
import { formatWhen, RECORDED_LABEL } from "./provenance-facts";
import { comparisonNote } from "./recorded-catalogue";
import type { GenerateSession, ReviewedRun } from "./session";
import { strategyLabel } from "./strategies";
import { useCandidateStatuses, useProject } from "./use-session";

const NO_GLYPH =
  "The face has no glyph for this character, so there is nothing to compare it with.";

const runLabel = ({ candidates, record }: ReviewedRun) =>
  `${formatWhen(record.startedAt)}, ${strategyLabel(record.producedBy)}${record.recorded ? ", recorded" : ""}, ${candidates.length} ${candidates.length === 1 ? "candidate" : "candidates"}`;

const tally = (
  run: ReviewedRun,
  statuses: ReadonlyMap<string, CandidateStatus>
) => {
  const counts = { accepted: 0, passed: 0, proposed: 0, rejected: 0 };
  for (const { candidate, evaluation } of run.candidates) {
    const status = statuses.get(candidate.id);
    if (status) {
      counts[status] += 1;
    }
    if (status === "proposed" && evaluation.verdict === "pass") {
      counts.passed += 1;
    }
  }
  return counts;
};

interface CandidateBoardProps {
  /** True while a run is under way. */
  readonly busy: boolean;
  readonly runs: readonly ReviewedRun[];
  readonly session: GenerateSession;
  /** The run on the board. Undefined before the first run. */
  readonly shown: ReviewedRun | undefined;
}

/**
 * The candidates of one run, to be decided on: accept, reject, accept
 * everything that passed, or generate one again. Their standing is read from
 * the project, so an undo elsewhere shows here at once.
 */
export function CandidateBoard({
  busy,
  runs,
  session,
  shown,
}: CandidateBoardProps) {
  const workspace = useWorkspace();
  const project = useProject();
  const statuses = useCandidateStatuses();
  const options = useMemo(
    () => runs.map((run) => ({ label: runLabel(run), value: run.id })),
    [runs]
  );
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
  const shownId = shown?.id;
  const regenerate = useCallback(
    (key: string) => {
      if (shownId !== undefined) {
        session.regenerate(shownId, key);
      }
    },
    [session, shownId]
  );
  const acceptPassed = useCallback(() => {
    if (shownId !== undefined) {
      session.acceptPassed(shownId);
    }
  }, [session, shownId]);

  if (!shown) {
    return (
      <p className="ty-lede">
        No run yet. Run a generation above and its candidates appear here, each
        in a dotted frame until you accept or reject it.
      </p>
    );
  }
  const face = project.faces.find((known) => known.id === shown.faceId);
  if (!face) {
    return (
      <Notice>
        The face this run was made for is no longer in the project, so its
        candidates are gone with it. Run a generation for another face.
      </Notice>
    );
  }
  const counts = tally(shown, statuses);
  const { record } = shown;
  const notCompared =
    (shown.recorded && comparisonNote(shown.recorded, face.description)) ||
    NO_GLYPH;
  return (
    <div className="ty-generate-stack">
      {runs.length > 1 ? (
        <div className="ty-generate-fields">
          <Select
            label="Run on the board"
            onChange={session.showRun}
            options={options}
            value={shown.id}
          />
        </div>
      ) : null}
      <p data-run-source={record.recorded ? "recorded" : "live"}>
        {shown.candidates.length}{" "}
        {shown.candidates.length === 1 ? "candidate" : "candidates"} for{" "}
        {face.description.fullName} from the{" "}
        {strategyLabel(record.producedBy).toLowerCase()} strategy
        {record.model ? `, ${record.model}` : ""}.{" "}
        {record.recorded
          ? `${RECORDED_LABEL}, replayed: this is saved output, not a live model answer. `
          : ""}
        {counts.proposed} proposed, {counts.accepted} accepted,{" "}
        {counts.rejected} rejected.
      </p>
      {record.unmade.length > 0 ? (
        <Notice>
          No candidate was made for {record.unmade.length} of{" "}
          {shown.targets.length}{" "}
          {shown.targets.length === 1 ? "target" : "targets"}. The run record
          below gives the reason for each.
        </Notice>
      ) : null}
      {shown.candidates.length > 0 ? (
        <>
          <div className="ty-generate-actions">
            <Button
              disabled={counts.passed === 0}
              onClick={acceptPassed}
              symbol="check"
            >
              Accept everything that passed ({counts.passed})
            </Button>
            <span className="ty-generate-reason">
              Each acceptance is its own revision. Regenerating with a rule or a
              recorded run gives the same outline again; a model draws a new
              one.
            </span>
          </div>
          <ul aria-label="Candidates" className="ty-generate-board">
            {shown.candidates.map((reviewed) => (
              <CandidateCell
                busy={busy}
                key={reviewed.candidate.id}
                metrics={face.description.metrics}
                notCompared={notCompared}
                onAccept={accept}
                onRegenerate={regenerate}
                onReject={reject}
                reviewed={reviewed}
                status={statuses.get(reviewed.candidate.id)}
              />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
