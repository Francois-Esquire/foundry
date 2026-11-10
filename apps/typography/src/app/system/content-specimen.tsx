import { useCallback, useState } from "react";
import {
  type CompositionEntry,
  CompositionList,
} from "~/ui/content/composition-list";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import { EmptyState } from "~/ui/content/empty-state";
import { GlyphCell, type GlyphCellState } from "~/ui/content/glyph-cell";
import { GlyphGrid } from "~/ui/content/glyph-grid";
import { TitleBlock, TitleBlockItem } from "~/ui/content/title-block";
import { Tofu } from "~/ui/content/tofu";
import { Button } from "~/ui/controls/button";
import { FileDrop } from "~/ui/controls/file-drop";
import type { SortedFiles } from "~/ui/controls/file-sorting";
import { Notice } from "~/ui/controls/notice";
import { ProgressLine } from "~/ui/controls/progress-line";
import { Columns } from "~/ui/layout/columns";
import { RuledSection } from "~/ui/layout/ruled-section";
import { hashFor } from "../hash-location";
import { ignore, StateSample, StateSamples } from "./state-sample";

const CELL_STATES: readonly {
  readonly name: string;
  readonly state: GlyphCellState;
}[] = [
  { name: "In the source font", state: "source" },
  { name: "Changed or added after the source", state: "edited" },
  { name: "Generated or inferred candidate", state: "candidate" },
  { name: "Observed candidate", state: "observed" },
  { name: "Missing", state: "missing" },
];

const GRID_STATES: Readonly<Record<string, GlyphCellState>> = {
  G: "edited",
  K: "edited",
  T: "observed",
  U: "observed",
  V: "candidate",
  W: "candidate",
  X: "candidate",
  Y: "missing",
  Z: "missing",
};

const ALPHABET = Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
const TOFU_SIZES = [11, 21, 30, 60] as const;
const FONT_FILES = [".ttf", ".otf", ".woff2"] as const;

interface Measure {
  readonly change: string;
  readonly edit: number;
  readonly key: string;
  readonly name: string;
  readonly source: number;
}

const MEASURES: readonly Measure[] = [
  { change: "+16", edit: 1130, key: "A", name: "Advance", source: 1114 },
  { change: "0", edit: 86, key: "B", name: "Left bearing", source: 86 },
  { change: "+16", edit: 108, key: "C", name: "Right bearing", source: 92 },
  { change: "0", edit: 1082, key: "D", name: "x-height", source: 1082 },
];

const MEASURE_COLUMNS: readonly DataColumn<Measure>[] = [
  { cell: (row) => row.key, header: "Key", id: "key", kind: "label" },
  { cell: (row) => row.name, header: "Measure", id: "name", kind: "text" },
  {
    cell: (row) => row.source,
    header: "Source",
    id: "source",
    kind: "numeric",
  },
  { cell: (row) => row.edit, header: "Edit", id: "edit", kind: "numeric" },
  {
    cell: (row) => row.change,
    header: "Change",
    id: "change",
    kind: "numeric",
  },
];

const measureKey = (row: Measure) => row.key;

const COMPOSITION: readonly CompositionEntry[] = [
  { name: "Greek", percent: 100, standing: { kind: "level", level: 3 } },
  {
    href: hashFor("coverage"),
    name: "Latin",
    percent: 94,
    standing: { kind: "level", level: 2 },
  },
  { name: "Cyrillic", percent: 38, standing: { kind: "level", level: 1 } },
  {
    name: "Devanagari",
    percent: 0,
    standing: { count: 8, kind: "candidates" },
  },
  { name: "Arabic", percent: 0, standing: { kind: "missing" } },
];

function GlyphsSpecimen() {
  const [selected, setSelected] = useState(0x41);
  return (
    <RuledSection
      heading="Glyph cells"
      lede="A cell shows a letterform over its code point. Work in the face has a solid carbon frame. A candidate is dotted when it was generated or inferred, and in corner brackets when it was traced from evidence. A missing character gets the crossed box, never a system fallback font. Selection fills the cell with the colour of its layer."
    >
      <StateSamples>
        {CELL_STATES.map(({ name, state }) => (
          <StateSample key={state} name={name}>
            <GlyphCell codePoint={0x52} state={state}>
              R
            </GlyphCell>
          </StateSample>
        ))}
        {CELL_STATES.map(({ name, state }) => (
          <StateSample key={state} name={`${name}, selected`}>
            <GlyphCell codePoint={0x52} selected state={state}>
              R
            </GlyphCell>
          </StateSample>
        ))}
        <StateSample force="hover" name="Hover">
          <GlyphCell codePoint={0x52} onSelect={ignore} state="source">
            R
          </GlyphCell>
        </StateSample>
        <StateSample force="focus" name="Focus">
          <GlyphCell codePoint={0x52} onSelect={ignore} state="source">
            R
          </GlyphCell>
        </StateSample>
      </StateSamples>
      <div className="ty-system-block">
        <GlyphGrid label="Basic Latin capitals">
          {ALPHABET.map((letter) => {
            const codePoint = letter.codePointAt(0) ?? 0;
            return (
              <GlyphCell
                characterName={`Latin capital letter ${letter.toLowerCase()}`}
                codePoint={codePoint}
                key={letter}
                onSelect={setSelected}
                selected={codePoint === selected}
                state={GRID_STATES[letter] ?? "source"}
              >
                {letter}
              </GlyphCell>
            );
          })}
        </GlyphGrid>
      </div>
      <ul className="ty-system-symbols">
        {TOFU_SIZES.map((size) => (
          <li key={size}>
            <Tofu size={size} />
            Missing character at {size} px
          </li>
        ))}
      </ul>
    </RuledSection>
  );
}

function RecordsSpecimen() {
  return (
    <RuledSection
      heading="Title block, table and composition"
      lede="Facts about one thing sit in a title block, facts about many in a table, and what a face is made of in a composition list."
    >
      <TitleBlock>
        <TitleBlockItem label="Glyph" weight={0.55}>
          <span className="ty-system-letter">a</span>
        </TitleBlockItem>
        <TitleBlockItem label="Character" weight={1.7}>
          U+0061 Latin small letter a
        </TitleBlockItem>
        <TitleBlockItem label="Source" weight={1.25}>
          Sofia Sans, weight 700
        </TitleBlockItem>
        <TitleBlockItem label="Revision" weight={1.4}>
          3 of 3, edit in progress
        </TitleBlockItem>
      </TitleBlock>
      <div className="ty-system-block">
        <Columns template="1.3fr 1fr">
          <DataTable
            caption="Measures of the glyph, in font units"
            columns={MEASURE_COLUMNS}
            rowKey={measureKey}
            rows={MEASURES}
          />
          <CompositionList entries={COMPOSITION} label="Composition" />
        </Columns>
      </div>
    </RuledSection>
  );
}

function StatusSpecimen() {
  const [summary, setSummary] = useState("Nothing added yet.");
  const [dismissed, setDismissed] = useState(false);
  const report = useCallback(
    ({ accepted, rejected }: SortedFiles) =>
      setSummary(`${accepted.length} accepted, ${rejected.length} rejected.`),
    []
  );
  const dismiss = useCallback(() => setDismissed(true), []);
  return (
    <RuledSection
      heading="Status and files"
      lede="Status is a line that never blocks the work. An empty place says what is absent and offers the way out."
    >
      <StateSamples wide>
        <StateSample name="Note">
          <Notice>Lato Regular was imported. 2,741 characters.</Notice>
        </StateSample>
        <StateSample name="Problem, with a way out">
          {dismissed ? (
            <Notice>The problem was dismissed.</Notice>
          ) : (
            <Notice
              action={<Button onClick={ignore}>Start again</Button>}
              onDismiss={dismiss}
              tone="problem"
            >
              The font engine did not start. Check the connection and start it
              again.
            </Notice>
          )}
        </StateSample>
        <StateSample name="Waiting, amount unknown">
          <ProgressLine label="Starting the font engine" />
        </StateSample>
        <StateSample name="Waiting, amount known">
          <ProgressLine label="Building 3 of 8 faces" value={0.375} />
        </StateSample>
        <StateSample name={`File drop. ${summary}`}>
          <FileDrop
            accept={FONT_FILES}
            label="Add font files"
            onFiles={report}
          />
        </StateSample>
        <StateSample force="hover" name="File drop, hover">
          <FileDrop
            accept={FONT_FILES}
            label="Add font files"
            onFiles={ignore}
          />
        </StateSample>
        <StateSample force="focus" name="File drop, focus">
          <FileDrop
            accept={FONT_FILES}
            label="Add font files"
            onFiles={ignore}
          />
        </StateSample>
        <StateSample force="over" name="File drop, files held over it">
          <FileDrop
            accept={FONT_FILES}
            label="Add font files"
            onFiles={ignore}
          />
        </StateSample>
        <StateSample name="File drop, unavailable">
          <FileDrop
            accept={FONT_FILES}
            disabled
            label="Add font files"
            onFiles={ignore}
          />
        </StateSample>
        <StateSample name="Empty state">
          <EmptyState
            action={<Button symbol="add">Import font</Button>}
            symbol="library"
            title="No fonts yet"
          >
            The library lists every source font in the project. Import one to
            begin.
          </EmptyState>
        </StateSample>
      </StateSamples>
    </RuledSection>
  );
}

export function ContentSpecimen() {
  return (
    <>
      <GlyphsSpecimen />
      <RecordsSpecimen />
      <StatusSpecimen />
    </>
  );
}
