import { useCallback } from "react";
import { TitleBlock, TitleBlockItem } from "~/ui/content/title-block";
import { Button, ButtonLink } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { RuledSection } from "~/ui/layout/ruled-section";
import { saveBytes } from "~/workspace/files";
import type { BuiltFont, OutputRun } from "./build-run";
import { CheckTable, summariseReport } from "./check-table";
import type { BuildRun } from "./session";

interface ResultsSectionProps {
  /** Family and style of each face in the project, by face id. */
  readonly labels: ReadonlyMap<string, string>;
  readonly onBuildAgain: () => void;
  /** True when the plan or the project changed after the build. */
  readonly outdated: boolean;
  readonly run: BuildRun;
}

const KILOBYTE = 1024;

export const formatSize = (bytes: number) =>
  `${(bytes / KILOBYTE).toLocaleString("en", { maximumFractionDigits: 1 })} KB`;

export const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/** Where the Proof place shows one built font. */
const proofAddress = (fontId: string) =>
  `#/proof/built/${encodeURIComponent(fontId)}`;

function BuiltOutput({
  font,
  label,
}: {
  readonly font: BuiltFont;
  readonly label: string;
}) {
  const download = useCallback(
    () => saveBytes(font.fileName, font.bytes),
    [font]
  );
  return (
    <article className="ty-export-output" data-testid="built-font">
      <h3 className="ty-heading">{font.fileName}</h3>
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
      <CheckTable fileName={font.fileName} report={font.report} />
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
        <ButtonLink href={proofAddress(font.id)}>Prove this font</ButtonLink>
      </div>
    </article>
  );
}

function Output({
  labels,
  onBuildAgain,
  output,
}: {
  readonly labels: ReadonlyMap<string, string>;
  readonly onBuildAgain: () => void;
  readonly output: OutputRun;
}) {
  const { fileName, progress } = output;
  switch (progress.status) {
    case "built":
      return (
        <BuiltOutput
          font={progress.font}
          label={labels.get(output.faceId) ?? "A face no longer in the project"}
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
          />
        ))}
      </div>
    </RuledSection>
  );
}
