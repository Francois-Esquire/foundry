import { useMemo } from "react";
import type {
  PlannedGlyph,
  ScriptExtensionPlan,
} from "~/generation/script-extension/plan";
import { codePointName } from "~/ui/content/code-point";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import {
  codePointsOf,
  drawnInWords,
  KIND_NAMES,
  ruleInWords,
} from "./plan-rows";

type PlannedWord = ScriptExtensionPlan["words"][number];

const glyphKey = (glyph: PlannedGlyph) => glyph.name;
const wordKey = (word: PlannedWord) => word.text;

const spelled = (text: string) =>
  codePointsOf(text).map(codePointName).join(" ");

interface PlanTablesProps {
  /** The face the plan is for, by its full name. */
  readonly faceName: string;
  readonly plan: ScriptExtensionPlan;
}

/** The plan: each glyph with its character or its rule, then the test words. */
export function PlanTables({ faceName, plan }: PlanTablesProps) {
  const language = `und-${plan.iso15924}`;
  const glyphColumns = useMemo(
    (): readonly DataColumn<PlannedGlyph>[] => [
      {
        cell: (glyph) => (
          <span className="ty-generate-literal">{glyph.name}</span>
        ),
        header: "Glyph",
        id: "name",
        kind: "label",
      },
      {
        cell: (glyph) =>
          glyph.characters.map(codePointName).join(" ") || "None",
        header: "Character",
        id: "character",
        kind: "text",
      },
      {
        cell: (glyph) => KIND_NAMES[glyph.rule.kind],
        header: "Kind",
        id: "kind",
        kind: "text",
      },
      {
        cell: (glyph) => ruleInWords(glyph, plan.layout),
        header: "Rule",
        id: "rule",
        kind: "text",
      },
      {
        cell: drawnInWords,
        header: "How it is drawn",
        id: "drawn",
        kind: "text",
      },
    ],
    [plan.layout]
  );
  const wordColumns = useMemo(
    (): readonly DataColumn<PlannedWord>[] => [
      {
        cell: (word) => (
          <span className="ty-extension-text" lang={language}>
            {word.text}
          </span>
        ),
        header: "Text",
        id: "text",
        kind: "text",
      },
      {
        cell: (word) => <span className="ty-code">{spelled(word.text)}</span>,
        header: "Characters",
        id: "characters",
        kind: "text",
      },
      {
        cell: (word) => word.glyphs.join(" "),
        header: "Must shape to",
        id: "glyphs",
        kind: "text",
      },
    ],
    [language]
  );
  return (
    <div className="ty-generate-stack">
      <DataTable
        caption="Planned glyphs, each with its character or its rule"
        columns={glyphColumns}
        rowKey={glyphKey}
        rows={plan.glyphs}
      />
      <h3 className="ty-label">Test words</h3>
      <p className="ty-extension-measure">
        The words are printed here in your system's type, not in {faceName},
        which cannot set them. After verification each one is drawn in the built
        font's own outlines.
      </p>
      <DataTable
        caption="Test words and the glyph sequence each must shape to"
        columns={wordColumns}
        rowKey={wordKey}
        rows={plan.words}
      />
    </div>
  );
}
