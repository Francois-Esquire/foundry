import { Columns } from "~/ui/layout/columns";
import { RuledSection } from "~/ui/layout/ruled-section";
import { CONTROL_SYMBOL_NAMES, LineSymbol } from "~/ui/symbols/line-symbol";
import { Mark, type MarkKind } from "~/ui/symbols/mark";
import { PLACES } from "../places";

const INKS = [
  { name: "Tape", note: "The ground.", token: "--tape" },
  { name: "Ink", note: "Source glyphs, rules, type.", token: "--ink" },
  { name: "Rule", note: "Hairlines inside a group.", token: "--rule" },
  {
    name: "Carbon blue",
    note: "Edits, generated and inferred work.",
    token: "--carbon",
  },
] as const;

const LADDER = [
  { className: "ty-display", rule: "100 at 44 px", token: "--type-display" },
  { className: "ty-heading", rule: "200 at 24 px", token: "--type-heading" },
  { className: undefined, rule: "300 at 13 px", token: "--type-body" },
  { className: "ty-label", rule: "400 at 11 px", token: "--type-label" },
  { className: "ty-code", rule: "400 at 10.5 px", token: "--type-code" },
] as const;

const SPACES = [
  { size: 4, token: "--space-1" },
  { size: 8, token: "--space-2" },
  { size: 12, token: "--space-3" },
  { size: 16, token: "--space-4" },
  { size: 24, token: "--space-5" },
  { size: 30, token: "--space-6" },
] as const;

const MARKS: readonly MarkKind[] = [
  "source",
  "edited",
  "unconfirmed",
  "observed",
  "missing",
  "level",
  "revisions",
];

const sentenceCase = (name: string) =>
  `${name.charAt(0).toUpperCase()}${name.slice(1).replace("-", " ")}`;

export function FoundationsSpecimen() {
  return (
    <>
      <RuledSection
        heading="Ink, type and space"
        lede="Four colours, five type styles and six distances. Type gets lighter as it gets larger, so its strokes stay near one pixel."
      >
        <Columns>
          <ul className="ty-system-list">
            {INKS.map((ink) => (
              <li key={ink.token}>
                <i
                  className="ty-system-chip"
                  style={{ background: `var(${ink.token})` }}
                />
                <span>
                  {ink.name}. {ink.note}
                </span>
                <code className="ty-code">{ink.token}</code>
              </li>
            ))}
          </ul>
          <ul className="ty-system-list">
            {LADDER.map((step) => (
              <li key={step.token}>
                <span className={step.className}>Studio</span>
                <span>{step.rule}</span>
                <code className="ty-code">{step.token}</code>
              </li>
            ))}
          </ul>
          <ul className="ty-system-list">
            {SPACES.map((space) => (
              <li key={space.token}>
                <i className="ty-system-space" style={{ width: space.size }} />
                <span>{space.size} px</span>
                <code className="ty-code">{space.token}</code>
              </li>
            ))}
          </ul>
        </Columns>
      </RuledSection>

      <RuledSection
        heading="Symbols"
        lede="Eight symbols name the places. Smaller ones sit inside controls. One stroke width, no fills, and a symbol always keeps its name beside or below it."
      >
        <ul className="ty-system-places">
          {PLACES.map((place) => (
            <li key={place.id}>
              <LineSymbol name={place.symbol} />
              <span className="ty-label">{place.name}</span>
            </li>
          ))}
        </ul>
        <ul className="ty-system-symbols">
          {CONTROL_SYMBOL_NAMES.map((name) => (
            <li key={name}>
              <LineSymbol name={name} />
              {sentenceCase(name)}
            </li>
          ))}
        </ul>
      </RuledSection>

      <RuledSection
        heading="Marks"
        lede="Seven marks say where a glyph came from and what state it is in. Ink is the source font. Carbon blue is anything made after it: solid once it is in the face, dotted while generated or inferred work waits, corner brackets while lettering traced from evidence waits."
      >
        <ul className="ty-system-symbols">
          {MARKS.map((kind) => (
            <li key={kind}>
              <Mark kind={kind} />
            </li>
          ))}
          <li>
            <Mark kind="level" level={0}>
              Level 0 of 3
            </Mark>
          </li>
          <li>
            <Mark kind="level" level={3}>
              Level 3 of 3
            </Mark>
          </li>
          <li>
            <Mark kind="missing">Missing, 3 characters</Mark>
          </li>
          <li>
            <Mark kind="unconfirmed">Generated, not accepted</Mark>
          </li>
          <li>
            <Mark kind="observed">Observed, not accepted</Mark>
          </li>
          <li>
            <Mark kind="edited">Observed in the evidence, accepted</Mark>
          </li>
        </ul>
      </RuledSection>
    </>
  );
}
