import { useMemo } from "react";
import type { SheetDrawing } from "~/generation/sheet/drawing";
import type { Face } from "~/typeface/face";
import { outlineToPath } from "~/typeface/outline";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import { ProgressLine } from "~/ui/controls/progress-line";
import { Columns } from "~/ui/layout/columns";
import type { StyleReading } from "./session";
import { formatElapsed } from "./stage-board";
import { measuredFrom, type StyleFact, styleFacts } from "./style-facts";

const COLUMNS: readonly DataColumn<StyleFact>[] = [
  { cell: (fact) => fact.label, header: "Measure", id: "label", kind: "label" },
  {
    cell: (fact) => fact.value,
    header: "Value",
    id: "value",
    kind: "numeric",
  },
  { cell: (fact) => fact.note, header: "From", id: "note", kind: "text" },
];

const factKey = (fact: StyleFact) => fact.label;

type SheetTone = SheetDrawing["shapes"][number]["tone"];

const TONES: readonly SheetTone[] = ["guide", "label", "glyph"];

interface SheetPictureProps {
  readonly drawing: SheetDrawing;
  readonly name: string;
}

/**
 * The reference sheet, drawn from the same shapes as the picture a model is
 * sent: the face's glyphs in ink, the ruled cells in hairline.
 */
function SheetPicture({ drawing, name }: SheetPictureProps) {
  const paths = useMemo(
    () =>
      TONES.map((tone) => ({
        d: drawing.shapes
          .filter((shape) => shape.tone === tone)
          .map((shape) => outlineToPath(shape.outline))
          .join(""),
        tone,
      })),
    [drawing]
  );
  return (
    <svg
      aria-label={name}
      className="ty-generate-sheet"
      role="img"
      viewBox={`0 0 ${drawing.width} ${drawing.height}`}
    >
      {paths.map(({ d, tone }) => (
        <path d={d} data-tone={tone} key={tone} />
      ))}
    </svg>
  );
}

interface StylePanelProps {
  readonly face: Face;
  /** Undefined while the face is being measured. */
  readonly reading: StyleReading | undefined;
}

/** What Analyse measured from the face, beside the sheet a model would be shown. */
export function StylePanel({ face, reading }: StylePanelProps) {
  const facts = useMemo(
    () => (reading ? styleFacts(reading.style) : []),
    [reading]
  );
  if (!reading) {
    return <ProgressLine label={`Measuring ${face.description.fullName}`} />;
  }
  const { sheet, style } = reading;
  return (
    <Columns template="minmax(0, 5fr) minmax(0, 4fr)">
      <div className="ty-generate-stack">
        <DataTable
          caption={`What was measured from ${face.description.fullName}`}
          columns={COLUMNS}
          rowKey={factKey}
          rows={facts}
        />
        <p>
          Measured in {formatElapsed(reading.elapsedMs)} from{" "}
          {style.characters.length} glyphs: {measuredFrom(style)}. Figures are
          in font units.
        </p>
      </div>
      <figure className="ty-generate-stack">
        <SheetPicture
          drawing={sheet.drawing}
          name={`Style reference sheet: ${sheet.layout.cells.length} glyphs of ${face.description.fullName}, each in a labelled cell on a ruled baseline`}
        />
        <figcaption>
          The reference sheet. An image or vector model is sent this picture
          with the request, and nothing else from the font. A character under a
          holdout test is left off the sheet that is sent.
        </figcaption>
      </figure>
    </Columns>
  );
}
