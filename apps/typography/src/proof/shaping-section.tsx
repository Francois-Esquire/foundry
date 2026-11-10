import { type Outcome, OutcomeTag } from "~/export/outcome-tag";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import { RuledSection } from "~/ui/layout/ruled-section";
import type { Proof } from "./proof";
import type { ProofFont } from "./proof-subject";
import { SampleText } from "./sample-text";
import type { ShapedSide, ShapingTest } from "./shaping-tests";
import type { BrowserFont } from "./use-proof";

interface ShapingSectionProps {
  readonly browserFont: BrowserFont;
  readonly font: ProofFont;
  readonly proof: Proof;
}

interface Row {
  /** Set when the sample is a line of letters and not words chosen to shape. */
  readonly generic: boolean;
  readonly index: number;
  readonly scriptName: string;
  readonly test: ShapingTest;
}

const OUTCOMES: Readonly<Record<ShapingTest["verdict"], Outcome>> = {
  fail: "fail",
  "not-checked": "not-run",
  pass: "pass",
};

const glyphsOf = (side: ShapedSide | undefined) =>
  side ? String(side.glyphCount) : "None";

const clustersOf = (side: ShapedSide | undefined) =>
  side ? side.clusters.join(" ") : "None";

const rowKey = (row: Row) => String(row.index);

/** The table of shaping tests: counts and clusters in both fonts, and whether they agree. */
export function ShapingSection({
  browserFont,
  font,
  proof,
}: ShapingSectionProps) {
  const rows = proof.shaping.map((test, index): Row => {
    const entry = font.samples[index];
    return {
      generic: entry?.generic ?? false,
      index,
      scriptName: entry?.scriptName ?? "",
      test,
    };
  });
  const columns: readonly DataColumn<Row>[] = [
    {
      cell: (row) => (
        <SampleText
          browserFont={browserFont}
          proof={proof}
          text={row.test.text}
        />
      ),
      header: "Sample text",
      id: "sample",
      kind: "text",
    },
    {
      cell: (row) =>
        row.generic ? `${row.scriptName}, letters only` : row.scriptName,
      header: "Script",
      id: "script",
      kind: "text",
    },
    {
      cell: (row) => glyphsOf(row.test.source),
      header: "Glyphs, source",
      id: "source-glyphs",
      kind: "numeric",
    },
    {
      cell: (row) => glyphsOf(row.test.derived),
      header: "Glyphs, derived",
      id: "derived-glyphs",
      kind: "numeric",
    },
    {
      cell: (row) => (
        <span className="ty-code">{clustersOf(row.test.source)}</span>
      ),
      header: "Clusters, source",
      id: "source-clusters",
      kind: "text",
    },
    {
      cell: (row) => (
        <span className="ty-code">{clustersOf(row.test.derived)}</span>
      ),
      header: "Clusters, derived",
      id: "derived-clusters",
      kind: "text",
    },
    {
      cell: (row) => <OutcomeTag outcome={OUTCOMES[row.test.verdict]} />,
      header: "Result",
      id: "result",
      kind: "text",
    },
    {
      cell: (row) => (
        <span className="ty-proof-finding">{row.test.detail}</span>
      ),
      header: "Finding",
      id: "finding",
      kind: "text",
    },
  ];
  return (
    <RuledSection
      heading="Shaping tests"
      lede="Each sample is shaped by HarfBuzz in the source and in the derived font. A cluster is the position in the text a glyph came from, so matching clusters mean the same ligatures, conjuncts and marks."
    >
      {rows.length > 0 ? (
        <DataTable
          caption="Shaping tests on sample texts"
          columns={columns}
          rowKey={rowKey}
          rows={rows}
        />
      ) : (
        <p>
          This font keeps no letters of any script, so there is no sample text
          to shape.
        </p>
      )}
      {rows.some((row) => row.generic) ? (
        <p className="ty-proof-hint">
          A script marked letters only has no sample words on file. Its line is
          the script's own kept letters, which shows that they map and proves
          little about how the script shapes.
        </p>
      ) : null}
    </RuledSection>
  );
}
