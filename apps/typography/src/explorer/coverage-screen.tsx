import "./coverage.css";
import { useCallback, useMemo, useState } from "react";
import {
  coverageAddress,
  leadingScript,
  scopeKey,
} from "~/library/composition";
import { CompositionPanel } from "~/library/composition-panel";
import { faceLabel } from "~/library/face-names";
import { FaceSelect } from "~/library/face-select";
import { NoFonts } from "~/library/no-fonts";
import { useActiveFace, useFaceCoverage } from "~/library/use-face";
import type { Face } from "~/typeface/face";
import { Notice } from "~/ui/controls/notice";
import { ProgressLine } from "~/ui/controls/progress-line";
import { SearchField } from "~/ui/controls/search-field";
import { Select } from "~/ui/controls/select";
import { Columns } from "~/ui/layout/columns";
import { RuledSection } from "~/ui/layout/ruled-section";
import { SplitView } from "~/ui/layout/split-view";
import { type Scope, scopeName } from "~/unicode/scope";
import { CharacterGrid, type Reveal } from "./character-grid";
import { CharacterInspector } from "./character-inspector";
import { CoverageStatistics } from "./coverage-statistics";
import { ScopeOffers } from "./scope-offers";
import { scopeFromKey, scopeOptions } from "./scopes";
import { resultSections, scopeSections } from "./sections";
import { useCharacterSearch } from "./use-character-search";

const LATIN: Scope = { code: "Latn", kind: "script" };
const SCOPE_OPTIONS = scopeOptions();

const goTo = (scope: Scope) => {
  window.location.hash = coverageAddress(scope);
};

interface ExplorerProps {
  readonly face: Face;
  /** The writing system the address names, if it names one. */
  readonly named: string | undefined;
}

function Explorer({ face, named }: ExplorerProps) {
  const coverage = useFaceCoverage(face);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number>();
  const [reveal, setReveal] = useState<Reveal>();
  const search = useCharacterSearch(query);

  const scope = useMemo(
    () => scopeFromKey(named) ?? leadingScript(coverage.byScope) ?? LATIN,
    [coverage.byScope, named]
  );
  const unknown = named !== undefined && scopeFromKey(named) === undefined;
  const { classify } = coverage.classification;
  const scoped = useMemo(
    () => scopeSections(scope, classify),
    [classify, scope]
  );
  const found = useMemo(
    () => search.results && resultSections(search.results, classify),
    [classify, search.results]
  );
  const summary = coverage.byScope.find(
    (row) => scopeKey(row.scope) === scopeKey(scope)
  );

  const chooseScope = useCallback((key: string) => {
    const chosen = scopeFromKey(key);
    if (chosen) {
      setQuery("");
      goTo(chosen);
    }
  }, []);
  const showInScope = useCallback((target: Scope, codePoint: number) => {
    setQuery("");
    setSelected(codePoint);
    setReveal({ codePoint });
    goTo(target);
  }, []);

  const searching = query.trim() !== "";
  const name = scopeName(scope);
  const total =
    summary?.total ??
    scoped.reduce((sum, section) => sum + section.characters.length, 0);

  return (
    <div className="ty-coverage">
      <div className="ty-coverage-controls">
        <FaceSelect face={face} />
        <Select
          label="Writing system"
          onChange={chooseScope}
          options={SCOPE_OPTIONS}
          value={scopeKey(scope)}
        />
        <SearchField
          label="Find a character"
          onChange={setQuery}
          placeholder="A character, words from its name, U+0915 or 0900-097F"
          value={query}
        />
      </div>
      {unknown ? (
        <Notice tone="problem">
          No writing system is called {named}. Showing {name} instead. Choose
          another from the list above.
        </Notice>
      ) : null}
      <Columns template="minmax(0, 300px) minmax(0, 1fr)">
        <div className="ty-coverage-composition">
          <h2 className="ty-label">Composition</h2>
          <CompositionPanel coverage={coverage} faceName={faceLabel(face)} />
        </div>
        <SplitView
          inspector={
            selected === undefined ? (
              <p className="ty-coverage-inspector">
                Choose a character to see its name, the glyph it maps to and
                where it stands in this face.
              </p>
            ) : (
              <CharacterInspector
                codePoint={selected}
                coverage={coverage}
                face={face}
                onSelect={setSelected}
                onShowInScope={showInScope}
              />
            )
          }
          inspectorLabel="Character"
          inspectorWidth={340}
        >
          <div className="ty-coverage-main">
            <div className="ty-coverage-head">
              <h2 className="ty-heading">
                {searching ? "Search results" : name}
              </h2>
              {searching ? null : (
                <p>
                  {summary?.covered ?? 0} of {total} characters in{" "}
                  {faceLabel(face)}, sectioned by block.
                </p>
              )}
            </div>
            {searching ? null : (
              <ScopeOffers
                coverage={coverage}
                face={face}
                missing={summary ? summary.counts.missing : total}
                scope={scope}
              />
            )}
            {search.pending ? (
              <ProgressLine label="Searching the character names" />
            ) : null}
            {!search.pending && found?.length === 0 ? (
              <Notice>
                No character matches this search. Try words from a name such as
                devanagari ka, a code point such as U+0915, a range such as
                0900-097F, or paste the character itself.
              </Notice>
            ) : null}
            <div className="ty-coverage-frame">
              <CharacterGrid
                coverage={coverage}
                face={face}
                label={searching ? "Search results" : `${name} characters`}
                onSelect={setSelected}
                reveal={reveal}
                sections={found ?? scoped}
                selected={selected}
              />
            </div>
          </div>
        </SplitView>
      </Columns>
      <RuledSection
        heading="Statistics"
        lede="What this face holds overall, by writing system, and for which languages it has every required character."
      >
        <CoverageStatistics coverage={coverage} />
      </RuledSection>
    </div>
  );
}

interface CoverageScreenProps {
  /** The path below the place: the writing system, as in "#/coverage/Deva". */
  readonly path: readonly string[];
}

/** Coverage: browse Unicode by writing system and see what the chosen face has. */
export default function CoverageScreen({ path }: CoverageScreenProps) {
  const face = useActiveFace();
  if (!face) {
    return (
      <NoFonts symbol="coverage">
        Coverage shows which characters of each writing system a face has.
      </NoFonts>
    );
  }
  return <Explorer face={face} named={path[0]} />;
}
