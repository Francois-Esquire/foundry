import type {
  ExportFinding,
  ExportOutput,
  ExportResolution,
} from "~/packaging/resolving";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import { Button } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { ProgressLine } from "~/ui/controls/progress-line";
import { RuledSection } from "~/ui/layout/ruled-section";
import type { useEngineStatus } from "~/workspace/services";
import { derivedOutputs } from "./build-run";
import type { BuildRun } from "./session";

/** How the font engine is doing, as the services report it. */
type EngineStatus = ReturnType<typeof useEngineStatus>;

interface PlanSectionProps {
  /** Problems in what was typed, which the plan itself cannot carry. */
  readonly draftProblems: readonly string[];
  readonly engineStatus: EngineStatus;
  /** Family and style of each face in the project, by face id. */
  readonly labels: ReadonlyMap<string, string>;
  readonly onBuild: () => void;
  readonly resolution: ExportResolution;
  readonly run: BuildRun | undefined;
}

interface PlanRow {
  readonly label: string;
  readonly output: ExportOutput;
}

const counted = (count: number, singular: string) =>
  `${count.toLocaleString("en")} ${singular}${count === 1 ? "" : "s"}`;

const describeOutput = (output: ExportOutput) => {
  if (output.kind === "original") {
    return "Nothing to build. The plan changes nothing about this face, so its file would be the original. Download it under Original files.";
  }
  const { flavor, location, subset } = output.request;
  return [
    "Derived font",
    subset?.characters
      ? counted(subset.characters.length, "character")
      : "every character",
    subset?.features
      ? `${counted(subset.features.length, "chosen feature")}`
      : "every feature the kept glyphs need",
    location ? "pinned to one instance" : undefined,
    flavor === "woff2" ? "packed as WOFF2" : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
};

const COLUMNS: readonly DataColumn<PlanRow>[] = [
  { cell: (row) => row.label, header: "Face", id: "face", kind: "label" },
  {
    cell: (row) =>
      row.output.kind === "derived" ? row.output.fileName : "No file",
    header: "File",
    id: "file",
    kind: "text",
  },
  {
    cell: (row) => describeOutput(row.output),
    header: "What is built",
    id: "what",
    kind: "text",
  },
];

const rowKey = (row: PlanRow) => row.output.faceId;

function Finding({
  finding,
  labels,
  tone,
}: {
  readonly finding: ExportFinding;
  readonly labels: ReadonlyMap<string, string>;
  readonly tone: "note" | "problem";
}) {
  const label = finding.faceId ? labels.get(finding.faceId) : undefined;
  // Most messages already name their face. The licence ones do not.
  const named = label !== undefined && finding.message.includes(label);
  return (
    <Notice tone={tone}>
      {label && !named ? `${label}: ` : ""}
      {finding.message}
    </Notice>
  );
}

const PROGRESS_WORDS = {
  building: "Building",
  validating: "Checking",
} as const;

/** The line that says what the engine is doing right now. */
function BuildProgress({
  engineStatus,
  run,
}: {
  readonly engineStatus: EngineStatus;
  readonly run: BuildRun;
}) {
  const total = run.outputs.length;
  const index = run.outputs.findIndex(
    ({ progress }) =>
      progress.status === "building" || progress.status === "validating"
  );
  const current = run.outputs[index];
  if (engineStatus === "starting" || !current) {
    return <ProgressLine label="Starting the font engine" />;
  }
  const { status } = current.progress;
  const word =
    status === "validating"
      ? PROGRESS_WORDS.validating
      : PROGRESS_WORDS.building;
  return (
    <ProgressLine
      label={`${word} ${current.fileName}, ${index + 1} of ${total}`}
      value={(index + (status === "validating" ? 0.5 : 0)) / total}
    />
  );
}

/** The plan before anything is built: one output per face, and everything wrong or worth knowing. */
export function PlanSection({
  draftProblems,
  engineStatus,
  labels,
  onBuild,
  resolution,
  run,
}: PlanSectionProps) {
  const rows = resolution.outputs.map((output) => ({
    label: labels.get(output.faceId) ?? output.faceId,
    output,
  }));
  const toBuild = derivedOutputs(resolution).length;
  const problemCount = draftProblems.length + resolution.problems.length;
  const blocked = problemCount > 0;
  const running = run?.running ?? false;
  let standing =
    "Nothing is built until you ask. The fonts stay on this machine.";
  if (blocked) {
    standing = `Resolve the ${problemCount === 1 ? "problem" : `${problemCount} problems`} above to build.`;
  } else if (toBuild === 0) {
    standing =
      "There is nothing to build. Change the characters, the features, the format or the family name, or download the original files below.";
  }
  return (
    <RuledSection
      heading="Plan"
      lede="What will be built, one file per face, with every problem that blocks the build and every warning worth knowing before it."
    >
      <div className="ty-export-stack">
        {rows.length > 0 ? (
          <DataTable
            caption="The outputs of the export plan"
            columns={COLUMNS}
            rowKey={rowKey}
            rows={rows}
          />
        ) : null}
        <div className="ty-export-findings" data-testid="plan-problems">
          {draftProblems.map((problem) => (
            <Notice key={problem} tone="problem">
              {problem}
            </Notice>
          ))}
          {resolution.problems.map((finding) => (
            <Finding
              finding={finding}
              key={`${finding.faceId}:${finding.code}:${finding.message}`}
              labels={labels}
              tone="problem"
            />
          ))}
        </div>
        <div className="ty-export-findings" data-testid="plan-warnings">
          {resolution.warnings.map((finding) => (
            <Finding
              finding={finding}
              key={`${finding.faceId}:${finding.code}:${finding.message}`}
              labels={labels}
              tone="note"
            />
          ))}
        </div>
        <div className="ty-export-actions">
          <Button
            disabled={blocked || toBuild === 0 || running}
            onClick={onBuild}
            variant="solid"
          >
            {toBuild === 1 ? "Build 1 font" : `Build ${toBuild} fonts`}
          </Button>
          <p>{standing}</p>
        </div>
        {run?.running ? (
          <BuildProgress engineStatus={engineStatus} run={run} />
        ) : null}
      </div>
    </RuledSection>
  );
}
