import "./face.css";
import { useMemo } from "react";
import { coverageAddress } from "~/explorer/coverage-address";
import {
  type CompositionEntry,
  CompositionList,
} from "~/ui/content/composition-list";
import { Notice } from "~/ui/controls/notice";
import { ProgressLine } from "~/ui/controls/progress-line";
import {
  type CompositionRow,
  compositionRows,
  LEVEL_MEANINGS,
} from "./composition";
import type { FaceCoverage } from "./face-coverage";
import { useLanguageData } from "./use-face";

const entryOf = (row: CompositionRow): CompositionEntry => ({
  href: coverageAddress(row.scope),
  name: `${row.name}, ${row.covered} of ${row.total}`,
  percent: row.percent,
  standing: row.standing,
});

interface CompositionPanelProps {
  readonly coverage: FaceCoverage;
  /** Names the face, for the list's spoken label. */
  readonly faceName: string;
}

/**
 * What a face is made of, script by script, with what the dots mean printed
 * underneath. Each script leads to its characters in the coverage explorer.
 */
export function CompositionPanel({
  coverage,
  faceName,
}: CompositionPanelProps) {
  const data = useLanguageData();
  const entries = useMemo(
    () =>
      data.status === "loaded"
        ? compositionRows(coverage.byScope, data.languages, coverage.has).map(
            entryOf
          )
        : undefined,
    [coverage, data]
  );
  if (data.status === "unavailable") {
    return (
      <Notice tone="problem">
        The language data did not load, so the composition cannot be listed.
        Reload the page to try again.
      </Notice>
    );
  }
  if (!entries) {
    return <ProgressLine label="Reading the language data" />;
  }
  return (
    <div>
      <CompositionList entries={entries} label={`Composition of ${faceName}`} />
      <ul className="ty-composition-legend">
        {LEVEL_MEANINGS.map((meaning) => (
          <li key={meaning}>{meaning}</li>
        ))}
        <li>
          The dots count characters. They do not show that the script shapes
          correctly.
        </li>
      </ul>
    </div>
  );
}
