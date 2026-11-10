import type { ScriptExtension } from "~/generation/script-extension/extend";
import type { Face } from "~/typeface/face";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import { Notice } from "~/ui/controls/notice";
import {
  type Fact,
  provenanceFacts,
  RECORDED_LABEL,
} from "../provenance-facts";
import { ExtensionGlyphCell } from "./extension-glyph-cell";
import { scopeOf } from "./scope";

type Missing = ScriptExtension["missing"][number];

const MISSING_COLUMNS: readonly DataColumn<Missing>[] = [
  {
    cell: (missing) => (
      <span className="ty-generate-literal">{missing.name}</span>
    ),
    header: "Glyph",
    id: "name",
    kind: "label",
  },
  {
    cell: (missing) => missing.reason,
    header: "Why it was not made",
    id: "reason",
    kind: "text",
  },
];

const missingKey = (missing: Missing) => missing.name;

interface SheetGroup {
  readonly facts: readonly Fact[];
  /** The run ids of the sheets these facts are true of. */
  readonly sheets: string[];
}

/** Where each sheet came from, with sheets that share every fact told once. */
const sheetGroups = (runs: ScriptExtension["runs"]): SheetGroup[] => {
  const groups = new Map<string, SheetGroup>();
  for (const { candidates, record } of runs) {
    const [first] = candidates;
    const facts = first ? provenanceFacts(first.provenance, record) : [];
    const key = facts.map((fact) => `${fact.label}=${fact.value}`).join("|");
    const group = groups.get(key) ?? { facts, sheets: [] };
    group.sheets.push(record.runId);
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.facts.length > 0);
};

const count = (amount: number, noun: string) =>
  `${amount} ${noun}${amount === 1 ? "" : "s"}`;

interface ResultBoardProps {
  readonly extension: ScriptExtension;
  readonly face: Face;
  /** True while the extension's revision is applied. */
  readonly inFace: boolean;
}

/**
 * The result, to be looked at before anything enters the face: what was
 * made and from what, the planned glyphs that were not made with the reason
 * for each, and every glyph drawn large.
 */
export function ResultBoard({ extension, face, inFace }: ResultBoardProps) {
  const { glyphs, missing, plan, runs } = extension;
  const scope = scopeOf(plan);
  const mapped = glyphs.filter(
    (glyph) => glyph.planned.characters.length > 0
  ).length;
  const forms = glyphs.length - mapped;
  const recorded = runs.every((run) => run.record.recorded);
  return (
    <div className="ty-generate-stack">
      <p
        data-extension-result=""
        data-forms={forms}
        data-glyphs={glyphs.length}
        data-mapped={mapped}
        data-missing={missing.length}
      >
        {glyphs.length} of {count(scope.glyphs, "planned glyph")} made: {mapped}{" "}
        with a character, {count(forms, "form")} with no character.{" "}
        {missing.length} not made.{" "}
        {recorded
          ? `${RECORDED_LABEL}, replayed: this is saved model output, not a live model answer.`
          : ""}
      </p>
      {sheetGroups(runs).map(({ facts, sheets }) => (
        <dl
          className="ty-generate-facts"
          data-extension-sheets={sheets.length}
          key={sheets.join(" ")}
        >
          <div>
            <dt className="ty-label">
              {sheets.length === 1 ? "Sheet" : "Sheets"}
            </dt>
            <dd>{sheets.join(", ")}</dd>
          </div>
          {facts.map((fact) => (
            <div key={fact.label}>
              <dt className="ty-label">{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      ))}
      {missing.length > 0 ? (
        <>
          <Notice>
            {count(missing.length, "planned glyph")}{" "}
            {missing.length === 1 ? "was" : "were"} not made. The layout rules
            that need {missing.length === 1 ? "it" : "them"} are left out, and
            the extension is not complete.
          </Notice>
          <DataTable
            caption="Planned glyphs that were not made, each with the reason"
            columns={MISSING_COLUMNS}
            rowKey={missingKey}
            rows={missing}
          />
        </>
      ) : null}
      <ul aria-label="Glyphs of the extension" className="ty-extension-board">
        {glyphs.map((glyph) => (
          <ExtensionGlyphCell
            face={face}
            glyph={glyph}
            inFace={inFace}
            key={glyph.key}
            language={`und-${plan.iso15924}`}
          />
        ))}
      </ul>
    </div>
  );
}
