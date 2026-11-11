import type { Face } from "~/typeface/face";
import { Button } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { ProgressLine } from "~/ui/controls/progress-line";
import { formatWhen, SOURCE_WORDS } from "../provenance-facts";
import { comparisonNote, type RecordedEntry } from "../recorded-catalogue";
import { formatElapsed } from "../stage-board";
import type { FaceStanding } from "./face-standing";
import type { RunState, RunStep, SourceState } from "./session";

const STATUS_NAMES: Readonly<Record<RunStep["status"], string>> = {
  failed: "Failed",
  finished: "Done",
  running: "Running",
  waiting: "Waiting",
};

const unique = (values: readonly (string | undefined)[]) => [
  ...new Set(values.filter((value) => value !== undefined)),
];

/** What the recorded run is, from its own manifest: the facts printed before it is replayed. */
const sourceFacts = (entries: readonly RecordedEntry[]) => {
  const [first] = entries;
  const madeFrom = first?.madeFrom;
  return [
    {
      label: "Source",
      value: SOURCE_WORDS.recorded,
    },
    { label: "Run", value: first?.manifest.id ?? "" },
    {
      label: "Model",
      value: unique(entries.map((entry) => entry.output.model)).join(", "),
    },
    {
      label: "Model called",
      value: first ? formatWhen(first.manifest.createdAt) : "",
    },
    {
      label: "Sheets",
      value: entries
        .map((entry) => entry.output.name ?? entry.output.strategy)
        .join(", "),
    },
    {
      label: "Prompts",
      value: `${unique(entries.map((entry) => entry.output.promptFile)).join(", ")}, kept with the recorded run`,
    },
    {
      label: "Made from",
      value: madeFrom
        ? [madeFrom.family, madeFrom.style].filter(Boolean).join(" ")
        : "Not stated",
    },
  ];
};

function StepRow({ number, step }: { number: number; step: RunStep }) {
  return (
    <li className="ty-extension-step" data-status={step.status}>
      <span className="ty-code">{number}</span>
      <span>{step.label}</span>
      <span
        className="ty-label ty-extension-tag"
        data-on={step.status === "running" || step.status === "failed"}
        data-quiet={step.status === "waiting"}
      >
        {STATUS_NAMES[step.status]}
      </span>
      <span className="ty-extension-step-time">
        {step.elapsedMs === undefined ? "" : formatElapsed(step.elapsedMs)}
      </span>
      <span className="ty-extension-step-detail">{step.detail ?? ""}</span>
    </li>
  );
}

/** Why the run cannot start now. Undefined when it can. */
const blockedReason = (
  source: SourceState,
  standing: FaceStanding
): string | undefined => {
  if (standing.kind === "in-face") {
    return "The extension is in the face. Undo it to run again.";
  }
  if (standing.kind === "not-offered") {
    return standing.reason;
  }
  if (source.status === "failed") {
    return "The recorded run could not be listed.";
  }
  return source.status === "listed"
    ? undefined
    : "The recorded run is being listed.";
};

interface ExtensionRunPanelProps {
  readonly face: Face;
  readonly onListAgain: () => void;
  readonly onRun: () => void;
  readonly run: RunState;
  readonly source: SourceState;
  readonly standing: FaceStanding;
}

/**
 * Where the glyphs come from and the control that replays it, then the steps
 * of the run with what each came to. A failure names its step and the reason.
 */
export function ExtensionRunPanel({
  face,
  onListAgain,
  onRun,
  run,
  source,
  standing,
}: ExtensionRunPanelProps) {
  const running = run.status === "running";
  const blocked = blockedReason(source, standing);
  const steps = run.status === "idle" ? [] : run.steps;
  const done = steps.filter((step) => step.status === "finished").length;
  const at = steps.find((step) => step.status === "running");
  const failed = steps.find((step) => step.status === "failed");
  const [first] = source.status === "listed" ? source.entries : [];
  const mismatch = first && comparisonNote(first, face.description);
  return (
    <div className="ty-generate-stack">
      {source.status === "listed" ? (
        <dl className="ty-generate-facts" data-extension-source="">
          {sourceFacts(source.entries).map((fact) => (
            <div key={fact.label}>
              <dt className="ty-label">{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {source.status === "failed" ? (
        <Notice
          action={<Button onClick={onListAgain}>List the run again</Button>}
          tone="problem"
        >
          The recorded run could not be listed. {source.reason} Check that the
          app is being served, then list it again.
        </Notice>
      ) : null}
      {mismatch ? <Notice>{mismatch}</Notice> : null}
      <p className="ty-extension-measure">
        A model strategy is not offered here. The app holds no provider key, and
        the prompts for these sheets are kept with the recorded run, not in the
        app. The recorded run is the only source.
      </p>
      <div className="ty-generate-actions">
        <Button
          disabled={running || blocked !== undefined}
          onClick={onRun}
          variant="solid"
        >
          Replay the recorded run
        </Button>
        {blocked === undefined || running ? null : (
          <span className="ty-generate-reason">{blocked}</span>
        )}
      </div>
      {running ? (
        <ProgressLine
          label={`Running: ${at?.label ?? "starting"}`}
          value={done / steps.length}
        />
      ) : null}
      {run.status === "failed" ? (
        <Notice tone="problem">
          {failed ? `${failed.label} failed. ` : ""}
          {run.reason} Nothing was made and nothing entered the face. Replay the
          recorded run again.
        </Notice>
      ) : null}
      {steps.length > 0 ? (
        <ol aria-label="Steps of the run" className="ty-extension-steps">
          {steps.map((step, index) => (
            <StepRow key={step.id} number={index + 1} step={step} />
          ))}
        </ol>
      ) : null}
    </div>
  );
}
