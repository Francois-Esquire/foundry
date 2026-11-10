import { useEffect, useMemo, useState } from "react";
import { sheetHeight, sheetWidth } from "~/generation/sheet/layout";
import type { RawOutput } from "~/generation/strategies/strategy";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import { TitleBlock, TitleBlockItem } from "~/ui/content/title-block";
import { ScrollRegion } from "~/ui/layout/scroll-region";
import { formatCost } from "./cost";
import { formatWhen, RECORDED_LABEL } from "./provenance-facts";
import type { ReviewedRun } from "./session";
import { formatElapsed, STAGE_NAMES, type StageOutcome } from "./stage-board";
import { strategyLabel } from "./strategies";

const STAGE_COLUMNS: readonly DataColumn<StageOutcome>[] = [
  {
    cell: (outcome) => STAGE_NAMES[outcome.stage],
    header: "Stage",
    id: "stage",
    kind: "label",
  },
  {
    cell: (outcome) => (outcome.status === "finished" ? "Done" : "Skipped"),
    header: "Result",
    id: "result",
    kind: "text",
  },
  {
    cell: (outcome) => formatElapsed(outcome.elapsedMs),
    header: "Time",
    id: "time",
    kind: "numeric",
  },
  {
    cell: (outcome) => outcome.detail,
    header: "What happened",
    id: "detail",
    kind: "text",
  },
];

const stageKey = (outcome: StageOutcome) => outcome.stage;

interface Unmade {
  readonly key: string;
  readonly name: string;
  readonly reason: string;
}

const UNMADE_COLUMNS: readonly DataColumn<Unmade>[] = [
  { cell: (item) => item.name, header: "Target", id: "name", kind: "label" },
  {
    cell: (item) => item.reason,
    header: "Why no candidate was made",
    id: "reason",
    kind: "text",
  },
];

const unmadeKey = (item: Unmade) => item.key;

const totalOf = (outcomes: readonly StageOutcome[]) =>
  outcomes.reduce((sum, outcome) => sum + outcome.elapsedMs, 0);

type Sheet = Exclude<RawOutput, { readonly kind: "outlines" }>;

/**
 * The sheet a model returned, exactly as it came back. It is shown through
 * an image address, so nothing inside an SVG can run or reach the page.
 */
function ReturnedSheet({ sheet }: { readonly sheet: Sheet }) {
  const [address, setAddress] = useState<string>();
  useEffect(() => {
    const blob =
      sheet.kind === "sheet-svg"
        ? new Blob([sheet.svg], { type: "image/svg+xml" })
        : new Blob([sheet.image.bytes as Uint8Array<ArrayBuffer>], {
            type: sheet.image.mediaType,
          });
    const made = URL.createObjectURL(blob);
    setAddress(made);
    return () => URL.revokeObjectURL(made);
  }, [sheet]);
  return address ? (
    <img
      alt={`The sheet the model returned: ${sheet.layout.cells.map((cell) => cell.label).join(" ")}`}
      className="ty-generate-returned"
      height={sheetHeight(sheet.layout)}
      src={address}
      width={sheetWidth(sheet.layout)}
    />
  ) : null;
}

interface RunRecordProps {
  readonly run: ReviewedRun;
}

/** The record of one run: what made it, when, what it cost, and how long each stage took. */
export function RunRecordPanel({ run }: RunRecordProps) {
  const { outcomes, raw, record, regenerations, sent, targets } = run;
  const unmade = useMemo(
    () =>
      record.unmade.map(
        ({ key, reason }): Unmade => ({
          key,
          name: targets.find((target) => target.key === key)?.name ?? key,
          reason,
        })
      ),
    [record.unmade, targets]
  );
  const called = record.model !== undefined || record.recorded;
  const parameters = Object.entries(sent?.parameters ?? {});
  return (
    <div className="ty-generate-stack">
      <TitleBlock>
        <TitleBlockItem label="Run" weight={2}>
          {record.runId}
        </TitleBlockItem>
        <TitleBlockItem label="Source">
          {record.recorded ? `${RECORDED_LABEL}, replayed` : "Live run"}
        </TitleBlockItem>
        <TitleBlockItem label="Strategy">
          {strategyLabel(record.producedBy)}
        </TitleBlockItem>
        <TitleBlockItem label="Model" weight={2}>
          {record.model ?? "None"}
        </TitleBlockItem>
        <TitleBlockItem
          label={record.recorded ? "Model called" : "Output made"}
        >
          {formatWhen(record.createdAt)}
        </TitleBlockItem>
        <TitleBlockItem label="Pipeline run">
          {formatWhen(record.startedAt)}
        </TitleBlockItem>
        <TitleBlockItem label="Model latency">
          {record.modelLatencyMs === undefined
            ? "Not recorded"
            : formatElapsed(record.modelLatencyMs)}
        </TitleBlockItem>
        <TitleBlockItem label="Cost">
          {called ? formatCost(record.costUsd) : "None. No model was called"}
        </TitleBlockItem>
      </TitleBlock>
      <DataTable
        caption="Time taken by each stage of the run"
        columns={STAGE_COLUMNS}
        rowKey={stageKey}
        rows={outcomes}
      />
      <p>
        The stages took {formatElapsed(totalOf(outcomes))} on this machine in
        all.
        {record.recorded
          ? " The model latency is from when the model was really called."
          : ""}
      </p>
      {unmade.length > 0 ? (
        <DataTable
          caption="Targets no candidate was made for"
          columns={UNMADE_COLUMNS}
          rowKey={unmadeKey}
          rows={unmade}
        />
      ) : null}
      {record.notes.map((note) => (
        <p key={note}>
          <span className="ty-label">Note</span> {note}
        </p>
      ))}
      {regenerations.length > 0 ? (
        <ul className="ty-generate-regenerations">
          {regenerations.map((again) => (
            <li key={`${again.key}:${again.record.startedAt}`}>
              <span className="ty-label">Regenerated</span>{" "}
              {targets.find((target) => target.key === again.key)?.name ??
                again.key}{" "}
              at {formatWhen(again.record.startedAt)}, in{" "}
              {formatElapsed(totalOf(again.outcomes))}.
            </li>
          ))}
        </ul>
      ) : null}
      {sent?.prompt ? (
        <div className="ty-generate-stack">
          <h3 className="ty-label">What the model was sent</h3>
          <div className="ty-generate-prompt">
            <ScrollRegion label="Prompt">
              <p>{sent.prompt}</p>
            </ScrollRegion>
          </div>
          {parameters.length > 0 ? (
            <p className="ty-code">
              {parameters
                .map(([name, value]) => `${name}: ${JSON.stringify(value)}`)
                .join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}
      {raw.kind === "outlines" ? null : (
        <figure className="ty-generate-stack">
          <ReturnedSheet sheet={raw} />
          <figcaption>
            The sheet as the model returned it, before extraction.
            {record.recorded ? ` ${RECORDED_LABEL}: a saved file.` : ""}
          </figcaption>
        </figure>
      )}
    </div>
  );
}
