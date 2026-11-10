/** The style reference as rows a person can read: what was measured, and from what. */
import type { StyleReference } from "~/generation/style/reference";

type LineSources = StyleReference["metrics"]["sources"];
type VerticalLine = keyof LineSources;
type MetricSource = LineSources[VerticalLine];

export interface StyleFact {
  readonly label: string;
  /** Where the figure came from, or what it means. */
  readonly note: string;
  readonly value: string;
}

const SOURCE_NOTES: Readonly<Record<MetricSource, string>> = {
  assumed: "Assumed: the face has no letters to measure and declares none",
  declared: "Declared by the font, not measured",
  measured: "Measured from the face's letters",
};

const LINES: readonly (readonly [VerticalLine, string])[] = [
  ["ascender", "Ascender"],
  ["capHeight", "Cap height"],
  ["xHeight", "x-height"],
  ["descender", "Descender"],
];

const units = (value: number) => String(Math.round(value));

const ratio = (value: number) => value.toFixed(2);

export const styleFacts = (style: StyleReference): StyleFact[] => {
  const { inkDensity, sidebearings, stems } = style;
  return [
    {
      label: "Units per em",
      note: "The scale every other figure is in",
      value: units(style.unitsPerEm),
    },
    ...LINES.map(
      ([line, label]): StyleFact => ({
        label,
        note: SOURCE_NOTES[style.metrics.sources[line]],
        value: units(style.metrics[line]),
      })
    ),
    {
      label: "Upright stems",
      note: "The commonest thickness, measured across",
      value: units(stems.vertical),
    },
    {
      label: "Level strokes",
      note: "The commonest thickness, measured down",
      value: units(stems.horizontal),
    },
    {
      label: "Contrast",
      note: "Upright over level thickness. 1 is monoline",
      value: ratio(style.contrast),
    },
    {
      label: "Overshoot",
      note: "How far round shapes pass the lines flat shapes stop at",
      value: units(style.overshoot),
    },
    {
      label: "Slant",
      note: "Degrees clockwise from upright",
      value: style.slant.toFixed(1),
    },
    {
      label: "Sidebearings",
      note: "Beside a straight, a round and a diagonal edge",
      value: [sidebearings.straight, sidebearings.round, sidebearings.diagonal]
        .map(units)
        .join(", "),
    },
    {
      label: "Ink density",
      note: `Ink over the box of advance by height. Most glyphs fall between ${ratio(inkDensity.low)} and ${ratio(inkDensity.high)}`,
      value: ratio(inkDensity.median),
    },
    {
      label: "Average advance",
      note: "The mean width of the measured glyphs",
      value: units(style.averageAdvance),
    },
  ];
};

/** The characters the measurements were taken from, as text. */
export const measuredFrom = (style: StyleReference) =>
  style.characters
    .map((character) => String.fromCodePoint(character))
    .join(" ");
