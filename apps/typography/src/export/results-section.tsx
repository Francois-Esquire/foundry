import { useCallback } from "react";
import { subjectAddress } from "~/proof/proof-address";
import type { TypefaceProject } from "~/typeface/project";
import { formatSize, formatTime } from "~/ui/content/output-format";
import { TitleBlock, TitleBlockItem } from "~/ui/content/title-block";
import { Button, ButtonLink } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { RuledSection } from "~/ui/layout/ruled-section";
import { saveBytes } from "~/workspace/files";
import type { BuiltFont, OutputRun } from "./build-run";
import { CHECK_NAMES } from "./check-names";
import { summariseReport } from "./check-summary";
import { CheckTable } from "./check-table";
import { type BuildRun, changedSinceBuilt } from "./session";

interface ResultsSectionProps {
  /** Family and style of each face in the project, by face id. */
  readonly labels: ReadonlyMap<string, string>;
  readonly onBuildAgain: () => void;
  /** True when the plan or the project changed after the build. */
  readonly outdated: boolean;
  /** The project as it is now, to tell each font whether it is still current. */
  readonly project: TypefaceProject;
  readonly run: BuildRun;
}

function BuiltOutput({
  font,
  label,
  stale,
}: {
  readonly font: BuiltFont;
  readonly label: string;
  /** True when the project's revisions have moved on since the build. */
  readonly stale: boolean;
}) {
  const download = useCallback(
    () => saveBytes(font.fileName, font.bytes),
    [font]
  );
  return (
    <article
      className="ty-export-output"
      data-stale={stale}
      data-testid="built-font"
    >
      <h3 className="ty-heading">{font.fileName}</h3>
      {stale ? (
        <Notice>
          The project has changed since {font.fileName} was built, so this file
          does not hold the project as it is now. Build again to bring it up to
          date.
        </Notice>
      ) : null}
      <TitleBlock>
        <TitleBlockItem label="Built from" weight={2}>
          {label}
        </TitleBlockItem>
        <TitleBlockItem label="Size">
          {formatSize(font.bytes.byteLength)}
        </TitleBlockItem>
        <TitleBlockItem label="Built at">
          {formatTime(font.builtAt)}
        </TitleBlockItem>
        <TitleBlockItem label="Validation" weight={2}>
          {summariseReport(font.report)}
        </TitleBlockItem>
      </TitleBlock>
      <CheckTable
        caption={`Validation report for ${font.fileName}`}
        checks={font.report.checks}
        names={CHECK_NAMES}
      />
      {font.notes.length > 0 ? (
        <div>
          <h4 className="ty-label">Notes from the font engine</h4>
          <ul className="ty-export-details">
            {font.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="ty-export-actions">
        <Button onClick={download} symbol="download">
          Download {font.fileName}
        </Button>
        <ButtonLink href={subjectAddress({ id: font.id, kind: "built" })}>
          Prove this font
        </ButtonLink>
      </div>
    </article>
  );
}

function Output({
  labels,
  onBuildAgain,
  output,
  project,
}: {
  readonly labels: ReadonlyMap<string, string>;
  readonly onBuildAgain: () => void;
  readonly output: OutputRun;
  readonly project: TypefaceProject;
}) {
  const { fileName, progress } = output;
  switch (progress.status) {
    case "built":
      return (
        <BuiltOutput
          font={progress.font}
          label={labels.get(output.faceId) ?? "A face no longer in the project"}
          stale={changedSinceBuilt(progress.font, project)}
        />
      );
    case "failed":
      return (
        <Notice
          action={<Button onClick={onBuildAgain}>Build again</Button>}
          tone="problem"
        >
          {fileName} was not built. {progress.message}
        </Notice>
      );
    case "waiting":
      return <p>{fileName} is waiting for its turn.</p>;
    case "building":
      return <p>{fileName} is being built.</p>;
    default:
      return <p>{fileName} is built and is being checked.</p>;
  }
}

/** What the last build produced: each font with its validation report and its download. */
export function ResultsSection({
  labels,
  onBuildAgain,
  outdated,
  project,
  run,
}: ResultsSectionProps) {
  return (
    <RuledSection
      heading="Built fonts"
      lede="Each derived font with its validation report: the engine's own checks, the characters asked for, shaping on sample texts for the kept scripts, and the browser's font sanitizer."
    >
      <div className="ty-export-stack">
        {outdated && !run.running ? (
          <Notice>
            The plan or the project has changed since these fonts were built.
            Build again to bring them up to date.
          </Notice>
        ) : null}
        {run.outputs.map((output) => (
          <Output
            key={output.fileName}
            labels={labels}
            onBuildAgain={onBuildAgain}
            output={output}
            project={project}
          />
        ))}
      </div>
    </RuledSection>
  );
}
