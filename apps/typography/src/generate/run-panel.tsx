import { Button } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { ProgressLine } from "~/ui/controls/progress-line";
import type { Readiness } from "./request-draft";
import type { Activity } from "./session";
import {
  emptyBoard,
  formatElapsed,
  STAGE_NAMES,
  type StageLine,
  type StageStatus,
} from "./stage-board";

const STATUS_NAMES: Readonly<Record<StageStatus, string>> = {
  failed: "Failed",
  finished: "Done",
  running: "Running",
  skipped: "Skipped",
  waiting: "Waiting",
};

const WAITING = emptyBoard();

function StageRow({ line, number }: { line: StageLine; number: number }) {
  return (
    <li className="ty-generate-stage" data-status={line.status}>
      <span className="ty-code">{number}</span>
      <span className="ty-label">{STAGE_NAMES[line.stage]}</span>
      <span className="ty-label ty-generate-tag">
        {STATUS_NAMES[line.status]}
      </span>
      <span className="ty-generate-stage-time">
        {line.elapsedMs === undefined ? "" : formatElapsed(line.elapsedMs)}
      </span>
      <span className="ty-generate-stage-detail">{line.detail ?? ""}</span>
    </li>
  );
}

interface RunPanelProps {
  readonly activity: Activity | undefined;
  /** What the run button says, for example "Generate 3 glyphs". */
  readonly label: string;
  readonly onRun: () => void;
  readonly onStop: () => void;
  readonly readiness: Readiness;
}

/** The run control and the nine stages, each with what it did and how long it took. */
export function RunPanel({
  activity,
  label,
  onRun,
  onStop,
  readiness,
}: RunPanelProps) {
  const running = activity?.status === "running";
  const board = activity?.board ?? WAITING;
  const at = board.find((line) => line.status === "running");
  return (
    <div className="ty-generate-stack">
      <div className="ty-generate-actions">
        <Button
          disabled={running || !readiness.ready}
          onClick={onRun}
          variant="solid"
        >
          {label}
        </Button>
        {running ? (
          <Button onClick={onStop} symbol="close">
            Stop the run
          </Button>
        ) : null}
        {readiness.ready || running ? null : (
          <span className="ty-generate-reason">{readiness.reason}</span>
        )}
      </div>
      {running ? (
        <ProgressLine
          label={`Running: ${at ? STAGE_NAMES[at.stage] : "starting"}`}
        />
      ) : null}
      {activity?.failure ? (
        <Notice tone="problem">
          {STAGE_NAMES[activity.failure.stage]} failed.{" "}
          {activity.failure.reason} Nothing new was proposed. Change the request
          or the strategy, then run again.
        </Notice>
      ) : null}
      <ol aria-label="Stages of the run" className="ty-generate-stages">
        {board.map((line, index) => (
          <StageRow key={line.stage} line={line} number={index + 1} />
        ))}
      </ol>
    </div>
  );
}
