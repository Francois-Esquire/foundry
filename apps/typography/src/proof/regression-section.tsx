import { type Outcome, OutcomeTag } from "~/export/outcome-tag";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import { formatNumber as number } from "~/ui/content/output-format";
import { Notice } from "~/ui/controls/notice";
import { RuledSection } from "~/ui/layout/ruled-section";
import { DifferencePicture } from "./difference-picture";
import type { Proof } from "./proof";
import { SampleText } from "./sample-text";
import type { BrowserFont } from "./use-proof";
import type { Approximation, RegressionTest } from "./visual-regression";

interface RegressionSectionProps {
  readonly browserFont: BrowserFont;
  readonly proof: Proof;
}

interface Row {
  readonly index: number;
  readonly test: RegressionTest;
}

const RESULTS: Readonly<
  Record<
    RegressionTest["verdict"],
    { readonly outcome: Outcome; readonly word: string }
  >
> = {
  changed: { outcome: "pass", word: "Changed" },
  inconclusive: { outcome: "not-run", word: "Inconclusive" },
  "not-checked": { outcome: "not-run", word: "Not run" },
  regressed: { outcome: "fail", word: "Fail" },
  same: { outcome: "pass", word: "Pass" },
};

const FINDINGS: Readonly<Record<RegressionTest["verdict"], string>> = {
  changed:
    "Differs where the build changed or added glyphs, which is what was asked for.",
  inconclusive:
    "Differs in text made of unchanged glyphs. The build redrew every outline approximately, so this cannot be told apart from a regression. Look at the picture.",
  "not-checked": "The derived font keeps none of this text.",
  regressed:
    "Differs, though every glyph of this text was meant to stay as it is in the source.",
  same: "No pixel differs.",
};

const APPROXIMATIONS: Readonly<Record<Approximation, string>> = {
  converted:
    "This build converted PostScript outlines to TrueType, which refits every curve. Edges can move by a pixel in glyphs nobody changed, so a small difference here is not counted as a pass or as a failure.",
  pinned:
    "This font was pinned from a variable source. Pinning rounds every point to a whole unit, while the source is drawn at the exact position between its masters. Edges can move by a pixel in glyphs nobody changed, so a small difference here is not counted as a pass or as a failure.",
};

const differing = (test: RegressionTest) =>
  test.difference
    ? test.difference.sourceOnly + test.difference.derivedOnly
    : 0;

const shareOf = (test: RegressionTest) =>
  test.difference
    ? `${(test.difference.share * 100).toLocaleString("en", {
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
      })}%`
    : "None";

const rowKey = (row: Row) => String(row.index);

/** The pixel comparison of every sample, and a picture of each one that differs. */
export function RegressionSection({
  browserFont,
  proof,
}: RegressionSectionProps) {
  const rows = proof.regression.map((test, index) => ({ index, test }));
  const pictured = rows.filter((row) => differing(row.test) > 0);
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
        row.test.difference
          ? `${number(differing(row.test))} of ${number(row.test.difference.inked)}`
          : "None",
      header: "Differing pixels, of inked",
      id: "pixels",
      kind: "numeric",
    },
    {
      cell: (row) => shareOf(row.test),
      header: "Share",
      id: "share",
      kind: "numeric",
    },
    {
      cell: (row) => (
        <OutcomeTag outcome={RESULTS[row.test.verdict].outcome}>
          {RESULTS[row.test.verdict].word}
        </OutcomeTag>
      ),
      header: "Result",
      id: "result",
      kind: "text",
    },
    {
      cell: (row) => (
        <span className="ty-proof-finding">{FINDINGS[row.test.verdict]}</span>
      ),
      header: "Finding",
      id: "finding",
      kind: "text",
    },
  ];
  return (
    <RuledSection
      heading="Pixel comparison"
      lede="Each sample is set from the source font's own outlines and from the derived font's own outlines, both are filled into the same grid at 96 pixels to the em, and the pixels are compared one by one. Nothing is tolerated."
    >
      <div className="ty-proof-stack">
        {proof.approximation ? (
          <Notice>{APPROXIMATIONS[proof.approximation]}</Notice>
        ) : null}
        {rows.length > 0 ? (
          <DataTable
            caption="Pixel comparison of sample texts"
            columns={columns}
            rowKey={rowKey}
            rows={rows}
          />
        ) : (
          <p>There is no sample text to compare.</p>
        )}
        {pictured.length > 0 ? (
          <div className="ty-proof-stack">
            <ul className="ty-proof-legend">
              <li data-layer="source">Only in the source font</li>
              <li data-layer="derived">Only in the derived font</li>
              <li data-layer="both">In both</li>
            </ul>
            {pictured.map((row) => (
              <figure className="ty-proof-picture" key={row.index}>
                <figcaption>
                  <SampleText
                    browserFont={browserFont}
                    proof={proof}
                    text={row.test.text}
                  />
                  <span>{shareOf(row.test)} of inked pixels differ</span>
                </figcaption>
                {row.test.difference ? (
                  <DifferencePicture
                    label={`Where sample ${row.index + 1} differs`}
                    picture={row.test.difference.picture}
                  />
                ) : null}
              </figure>
            ))}
          </div>
        ) : null}
      </div>
    </RuledSection>
  );
}
