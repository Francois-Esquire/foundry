import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { FeatureSummary, FontBuilder } from "~/packaging/building";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import { Button } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { ProgressLine } from "~/ui/controls/progress-line";
import { createSummaryLoader, substitutionLine } from "./layout-summary";

/** Enough rules to show what a feature does without burying the table. */
const RULES_SHOWN = 6;

const rulesOf = (feature: FeatureSummary) => {
  const shown = feature.substitutions.slice(0, RULES_SHOWN);
  const more = feature.truncated || feature.substitutions.length > shown.length;
  return `${shown.map(substitutionLine).join(", ")}${more ? ", and more" : ""}`;
};

const COLUMNS: readonly DataColumn<FeatureSummary>[] = [
  {
    cell: (feature) => feature.tag,
    header: "Feature",
    id: "tag",
    kind: "label",
  },
  {
    cell: (feature) => feature.table,
    header: "Table",
    id: "table",
    kind: "text",
  },
  {
    cell: (feature) => feature.scripts.join(", "),
    header: "Scripts",
    id: "scripts",
    kind: "text",
  },
  {
    cell: (feature) => feature.lookupCount,
    header: "Lookups",
    id: "lookups",
    kind: "numeric",
  },
  {
    cell: (feature) =>
      feature.substitutions.length === 0 ? "" : rulesOf(feature),
    header: "Substitutions",
    id: "substitutions",
    kind: "text",
  },
];

const featureKey = (feature: FeatureSummary) =>
  `${feature.table} ${feature.tag}`;

const counted = (count: number, singular: string) =>
  `${count} ${singular}${count === 1 ? "" : "s"}`;

interface LayoutSummaryPanelProps {
  readonly builder: Pick<FontBuilder, "describeLayout">;
  /** How the font engine is doing, so a wait can say what it is waiting for. */
  readonly engineStatus: "failed" | "idle" | "ready" | "starting";
  readonly faceIndex: number;
  /** The source font file. It is read, never changed. */
  readonly font: Uint8Array;
}

/**
 * The face's layout tables, read by the font engine when asked for. The
 * engine starts on the first request, and the wait is shown for what it is.
 */
export function LayoutSummaryPanel({
  builder,
  engineStatus,
  faceIndex,
  font,
}: LayoutSummaryPanelProps) {
  const loader = useMemo(() => createSummaryLoader(builder), [builder]);
  const state = useSyncExternalStore(loader.subscribe, loader.getState);
  const load = useCallback(
    () => loader.load(font, faceIndex),
    [faceIndex, font, loader]
  );
  if (state.status === "idle") {
    return (
      <div className="ty-studio-summary">
        <p className="ty-lede">
          The font engine can list every feature with its scripts and
          substitutions, and count kerning pairs and anchors. It takes a moment
          to start the first time.
        </p>
        <Button onClick={load}>Load layout summary</Button>
      </div>
    );
  }
  if (state.status === "loading") {
    return (
      <ProgressLine
        label={
          engineStatus === "ready"
            ? "Reading the layout tables"
            : "Starting the font engine"
        }
      />
    );
  }
  if (state.status === "failed") {
    return (
      <Notice action={<Button onClick={load}>Try again</Button>} tone="problem">
        The layout summary could not be loaded. {state.message}
      </Notice>
    );
  }
  const { summary } = state;
  return (
    <div className="ty-studio-summary">
      <p className="ty-studio-summary-counts">
        {counted(summary.features.length, "feature")},{" "}
        {counted(summary.kerningPairCount, "kerning pair")},{" "}
        {counted(summary.anchorCount, "anchor")}
      </p>
      {summary.features.length > 0 ? (
        <DataTable
          caption="Layout features of the source font"
          columns={COLUMNS}
          rowKey={featureKey}
          rows={summary.features}
        />
      ) : null}
      <p className="ty-lede">
        This describes the source font file. Feature code added in the project
        is not included.
      </p>
    </div>
  );
}
