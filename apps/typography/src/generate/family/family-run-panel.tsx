import { Button } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { ProgressLine } from "~/ui/controls/progress-line";
import type { Readiness } from "../run-panel";
import type { FamilyActivity, WeightLine } from "./family-session";

const STATUS_NAMES: Readonly<Record<WeightLine["status"], string>> = {
  failed: "Failed",
  generated: "Done",
  "not-run": "Not started",
  running: "Running",
  waiting: "Waiting",
};

/** The stage rows' own states, which the stylesheet already draws. */
const ROW_STATES: Readonly<Record<WeightLine["status"], string>> = {
  failed: "failed",
  generated: "finished",
  "not-run": "skipped",
  running: "running",
  waiting: "waiting",
};

function WeightRow({ line, number }: { line: WeightLine; number: number }) {
  return (
    <li
      className="ty-generate-stage"
      data-status={ROW_STATES[line.status]}
      data-weight={line.weight}
      data-weight-status={line.status}
    >
      <span className="ty-code">{number}</span>
      <span className="ty-label ty-generate-literal">{line.name}</span>
      <span className="ty-label ty-generate-tag">
        {STATUS_NAMES[line.status]}
      </span>
      <span className="ty-generate-stage-time">{line.weight}</span>
      <span className="ty-generate-stage-detail">{line.detail ?? ""}</span>
    </li>
  );
}

/** What a failed weight means for the others, in a sentence. */
const afterFailure = (lines: readonly WeightLine[], failed: number): string => {
  const kept = lines.slice(0, failed).map((line) => line.name);
  const skipped = lines.slice(failed + 1).map((line) => line.name);
  return [
    kept.length > 0
      ? `${kept.join(", ")} ${kept.length === 1 ? "keeps" : "keep"} what ${kept.length === 1 ? "it" : "they"} made, and it is on the board below.`
      : "No weight before it had made anything.",
    skipped.length > 0
      ? `${skipped.join(", ")} ${skipped.length === 1 ? "was" : "were"} not started, so nothing more was spent.`
      : "",
    "Change the request or the strategy, then run again.",
  ]
    .filter(Boolean)
    .join(" ");
};

interface FamilyRunPanelProps {
  readonly activity: FamilyActivity | undefined;
  /** What the run button says, for example "Generate 6 glyphs at 3 weights". */
  readonly label: string;
  readonly onRun: () => void;
  readonly onStop: () => void;
  /** The weights a run would work at now, shown until a run has its own. */
  readonly planned: readonly WeightLine[];
  readonly readiness: Readiness;
}

/** The run control and the weights, each with how it went. */
export function FamilyRunPanel({
  activity,
  label,
  onRun,
  onStop,
  planned,
  readiness,
}: FamilyRunPanelProps) {
  const running = activity?.status === "running";
  const lines =
    activity && activity.lines.length > 0 ? activity.lines : planned;
  const at = running
    ? lines.findIndex((line) => line.status === "running")
    : -1;
  const current = lines[at];
  const failed = running
    ? -1
    : lines.findIndex((line) => line.status === "failed");
  const failure = lines[failed];
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
          label={
            current
              ? `Generating ${current.name}, weight ${current.weight}, ${at + 1} of ${lines.length}`
              : "Starting the run"
          }
          value={current ? at / lines.length : undefined}
        />
      ) : null}
      {activity?.failure ? (
        <Notice tone="problem">{activity.failure}</Notice>
      ) : null}
      {failure ? (
        <Notice tone="problem">
          {failure.name}, weight {failure.weight}, failed. {failure.detail}{" "}
          {afterFailure(lines, failed)}
        </Notice>
      ) : null}
      <ol aria-label="Weights of the run" className="ty-generate-stages">
        {lines.map((line, index) => (
          <WeightRow key={line.weight} line={line} number={index + 1} />
        ))}
      </ol>
    </div>
  );
}
