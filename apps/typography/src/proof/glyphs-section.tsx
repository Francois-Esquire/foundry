import { formatCodePoint } from "~/lib/code-point";
import type { FaceMetrics } from "~/typeface/face";
import { outlineToPath } from "~/typeface/outline";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import { RuledSection } from "~/ui/layout/ruled-section";
import {
  type ChangedGlyph,
  type GlyphChange,
  originOf,
} from "./changed-glyphs";
import type { Proof } from "./proof";

const CHANGES: Readonly<Record<GlyphChange, string>> = {
  added: "Added",
  redrawn: "Redrawn",
  "redrawn-and-respaced": "Redrawn and respaced",
  respaced: "Respaced",
};

/** The glyph as the derived font holds it, drawn in carbon: it was made after the source. */
function GlyphPicture({
  glyph,
  metrics,
}: {
  readonly glyph: ChangedGlyph;
  readonly metrics: FaceMetrics;
}) {
  if (!glyph.outline) {
    return <span>Not traced</span>;
  }
  const height = metrics.ascender - metrics.descender;
  return (
    <svg
      aria-hidden="true"
      className="ty-proof-glyph"
      viewBox={`${-height * 0.1} ${-metrics.ascender} ${height * 1.2} ${height}`}
    >
      <path d={outlineToPath(glyph.outline)} transform="scale(1 -1)" />
    </svg>
  );
}

const glyphKey = (glyph: ChangedGlyph) => glyph.key;

/** Every glyph the build changed or added, as it sits in the built file. */
export function GlyphsSection({ proof }: { readonly proof: Proof }) {
  const { metrics } = proof.description;
  const columns: readonly DataColumn<ChangedGlyph>[] = [
    {
      cell: (glyph) => <GlyphPicture glyph={glyph} metrics={metrics} />,
      header: "In the file",
      id: "picture",
      kind: "text",
    },
    { cell: (glyph) => glyph.name, header: "Glyph", id: "name", kind: "label" },
    {
      cell: (glyph) =>
        glyph.characters.length > 0
          ? glyph.characters.map(formatCodePoint).join(", ")
          : "No character. Reached through shaping.",
      header: "Characters",
      id: "characters",
      kind: "text",
    },
    {
      cell: (glyph) => CHANGES[glyph.change],
      header: "Change",
      id: "change",
      kind: "text",
    },
    {
      cell: (glyph) => originOf(glyph.provenance),
      header: "Origin",
      id: "origin",
      kind: "text",
    },
    {
      cell: (glyph) =>
        glyph.presence === "present"
          ? "Found in the file."
          : "Not found by its characters. The selection may have left it out, or shaping may still reach it. A subset renumbers glyphs, so the file cannot say which.",
      header: "Presence",
      id: "presence",
      kind: "text",
    },
  ];
  return (
    <RuledSection
      heading="Changed glyphs"
      lede="The glyphs this build redrew, respaced or added. Each drawing is read back from the built file, not from the project."
    >
      {proof.changed.length > 0 ? (
        <DataTable
          caption="Glyphs changed or added by the build"
          columns={columns}
          rowKey={glyphKey}
          rows={proof.changed}
        />
      ) : (
        <p>
          This build changed no glyph and added none. Every outline in it is the
          source font's.
        </p>
      )}
    </RuledSection>
  );
}
