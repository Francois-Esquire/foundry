import { useCallback, useMemo } from "react";
import { KEY_HINT } from "~/application/react";
import type { StrategyOption } from "~/generation/strategies/offering";
import type { RecordedEntry } from "~/generation/strategies/recorded/catalogue";
import type { Face } from "~/typeface/face";
import { Button } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { ProgressLine } from "~/ui/controls/progress-line";
import { SecretField } from "~/ui/controls/secret-field";
import { Select } from "~/ui/controls/select";
import type { CatalogueState } from "~/workspace/recorded-catalogue";
import { estimateCost, formatUsd } from "./cost";
import { formatWhen } from "./provenance-facts";
import { comparisonNote, entryLabel } from "./recorded-catalogue";

interface EstimateProps {
  readonly model: string;
  readonly targets: number;
}

/** What a model run may cost, before it starts: targets by the listed rate, labelled as an estimate. */
function Estimate({ model, targets }: EstimateProps) {
  const estimate = estimateCost(model, targets);
  if (!estimate) {
    return (
      <p>
        No price is listed here for {model}, so no estimate can be made. Check
        the price on fal before you run.
      </p>
    );
  }
  const { rate, usd } = estimate;
  return (
    <p className="ty-generate-estimate">
      <span className="ty-label ty-generate-tag">Estimate</span>{" "}
      <span data-estimate={usd.toFixed(2)}>
        {targets} {targets === 1 ? "target" : "targets"} at{" "}
        {formatUsd(rate.usdPerUnit)} listed per unit comes to {formatUsd(usd)}.
      </span>{" "}
      An estimate from the price fal listed on {rate.listedOn}, not a charge.{" "}
      {rate.note ? `${rate.note} ` : ""}
      fal states no cost per request, so the real charge shows only on your fal
      account.
    </p>
  );
}

interface RecordedDetailsProps {
  readonly catalogue: CatalogueState;
  readonly chosen: RecordedEntry | undefined;
  readonly face: Face;
  readonly onChoose: (entryId: string) => void;
  readonly onList: () => void;
}

function RecordedDetails({
  catalogue,
  chosen,
  face,
  onChoose,
  onList,
}: RecordedDetailsProps) {
  const options = useMemo(
    () =>
      catalogue.status === "listed"
        ? catalogue.catalogue.entries.map((entry) => ({
            label: entryLabel(entry),
            value: entry.id,
          }))
        : [],
    [catalogue]
  );
  if (catalogue.status === "failed") {
    return (
      <Notice
        action={<Button onClick={onList}>List the recorded runs again</Button>}
        tone="problem"
      >
        The recorded runs could not be listed: {catalogue.reason} Check that the
        app is still being served, then list them again.
      </Notice>
    );
  }
  if (catalogue.status !== "listed") {
    return <ProgressLine label="Listing the recorded runs" />;
  }
  const note = chosen && comparisonNote(chosen, face.description);
  const drew = chosen?.targets ?? [];
  return (
    <div className="ty-generate-stack">
      {options.length > 0 ? (
        <Select
          label="Recorded run to replay"
          onChange={onChoose}
          options={options}
          value={chosen?.id ?? ""}
        />
      ) : (
        <Notice>No recorded run is served with this app.</Notice>
      )}
      {catalogue.catalogue.problems.map((problem) => (
        <Notice key={problem} tone="problem">
          A recorded run could not be read and is left out. {problem}
        </Notice>
      ))}
      {chosen ? (
        <>
          <p>
            Recorded on {formatWhen(chosen.manifest.createdAt)} from{" "}
            {chosen.output.model}. It drew {drew.length}{" "}
            {drew.length === 1 ? "glyph" : "glyphs"}: {drew.join(" ")}. A replay
            draws the same ones, whatever is chosen above.
          </p>
          {chosen.purpose ? <p>{chosen.purpose}</p> : null}
          {note ? <Notice>{note}</Notice> : null}
        </>
      ) : null}
    </div>
  );
}

const ruleSummary = (ruled: number, targets: number): string => {
  if (targets === 0) {
    return "Choose characters above to see which of them a rule can build.";
  }
  if (ruled === targets) {
    return targets === 1
      ? "A rule can build this target from glyphs the face has."
      : `A rule can build all ${targets} targets from glyphs the face has.`;
  }
  return `A rule can build ${ruled} of the ${targets} targets. The others have to be drawn, and the run says so for each.`;
};

interface StrategyDetailsProps {
  readonly catalogue: CatalogueState;
  readonly face: Face;
  readonly onChooseRecorded: (entryId: string) => void;
  readonly onKey: (key: string) => void;
  readonly onListRecorded: () => void;
  /** The strategy that is chosen. */
  readonly option: StrategyOption;
  readonly providerKey: string;
  readonly recorded: RecordedEntry | undefined;
  /** How many of the targets a rule can build. */
  readonly ruled: number;
  readonly targets: number;
}

/** What the chosen strategy needs before it runs: a key and an estimate, a recorded run, or nothing. */
export function StrategyDetails({
  catalogue,
  face,
  onChooseRecorded,
  onKey,
  onListRecorded,
  option,
  providerKey,
  recorded,
  ruled,
  targets,
}: StrategyDetailsProps) {
  const choose = useCallback(
    (entryId: string) => onChooseRecorded(entryId),
    [onChooseRecorded]
  );
  if (option.kind === "recorded-run") {
    return (
      <RecordedDetails
        catalogue={catalogue}
        chosen={recorded}
        face={face}
        onChoose={choose}
        onList={onListRecorded}
      />
    );
  }
  if (option.kind === "procedural") {
    return <p>{ruleSummary(ruled, targets)}</p>;
  }
  return (
    <div className="ty-generate-stack">
      <SecretField
        hint={KEY_HINT}
        label="fal API key"
        onChange={onKey}
        value={providerKey}
      />
      {option.model ? (
        <Estimate model={option.model} targets={targets} />
      ) : null}
    </div>
  );
}
