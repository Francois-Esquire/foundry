import "./coverage.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FaceCoverage } from "~/library/face-coverage";
import { GlyphDrawing } from "~/library/outline-drawing";
import { useProject } from "~/library/use-face";
import { studioHash } from "~/studio/studio-address";
import type { Face } from "~/typeface/face";
import { describeProvenance } from "~/typeface/provenance";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import { GlyphCell } from "~/ui/content/glyph-cell";
import { GlyphGrid } from "~/ui/content/glyph-grid";
import { TitleBlock, TitleBlockItem } from "~/ui/content/title-block";
import { Tofu } from "~/ui/content/tofu";
import { Button, ButtonLink } from "~/ui/controls/button";
import { Mark } from "~/ui/symbols/mark";
import { type CharacterIdentity, describeCharacter } from "~/unicode/identity";
import { type Scope, scopeName, scopeOf } from "~/unicode/scope";
import { findScript } from "~/unicode/scripts";
import { useWorkspace } from "~/workspace/react";
import { cellStateOf, statusMarkOf } from "./character-status";
import { GlyphFigure } from "./glyph-figure";
import { type InspectedGlyph, inspectCharacter } from "./inspection";

const SHARED_SCRIPTS: Readonly<Record<string, string>> = {
  Zinh: "Inherited, takes the script of its base",
  Zyyy: "Common, used across scripts",
  Zzzz: "None",
};

const scriptLabel = (code: string) =>
  SHARED_SCRIPTS[code] ?? findScript(code)?.name ?? code;

/** The identity of a character, once its name has loaded. */
const useCharacterIdentity = (codePoint: number) => {
  const [identity, setIdentity] = useState<CharacterIdentity>();
  useEffect(() => {
    let current = true;
    describeCharacter(codePoint).then((described) => {
      if (current) {
        setIdentity(described);
      }
    });
    return () => {
      current = false;
    };
  }, [codePoint]);
  return identity?.codePoint === codePoint ? identity : undefined;
};

interface Fact {
  readonly label: string;
  readonly value: string;
}

const FACT_COLUMNS: readonly DataColumn<Fact>[] = [
  { cell: (fact) => fact.label, header: "Glyph", id: "label", kind: "label" },
  { cell: (fact) => fact.value, header: "Value", id: "value", kind: "numeric" },
];

const factKey = (fact: Fact) => fact.label;

const glyphFacts = (glyph: InspectedGlyph): Fact[] => {
  const { advance, bounds } = glyph;
  return [
    { label: "Glyph", value: glyph.identity },
    { label: "Name", value: glyph.name || "No name" },
    { label: "Advance", value: String(advance) },
    {
      label: "Bounds",
      value: bounds
        ? `${bounds.xMin}, ${bounds.yMin} to ${bounds.xMax}, ${bounds.yMax}`
        : "No outline",
    },
    {
      label: "Bearings",
      value: bounds
        ? `Left ${bounds.xMin}, right ${advance - bounds.xMax}`
        : "No outline",
    },
  ];
};

interface CharacterInspectorProps {
  readonly codePoint: number;
  readonly coverage: FaceCoverage;
  readonly face: Face;
  readonly onSelect: (codePoint: number) => void;
  /** Shows the character among the rest of its writing system. */
  readonly onShowInScope: (scope: Scope, codePoint: number) => void;
}

/**
 * One character in one face: what Unicode says about it, the glyph it maps
 * to drawn over the face's metric lines, the characters that share that
 * glyph, and where it stands, with the mark for that.
 */
export function CharacterInspector({
  codePoint,
  coverage,
  face,
  onSelect,
  onShowInScope,
}: CharacterInspectorProps) {
  const workspace = useWorkspace();
  const project = useProject();
  const identity = useCharacterIdentity(codePoint);
  const status = coverage.classification.classify(codePoint);
  const inspection = useMemo(
    () =>
      inspectCharacter(
        workspace,
        coverage.proposalFor,
        face.id,
        codePoint,
        status
      ),
    [codePoint, coverage, face.id, status, workspace]
  );
  const { glyph } = inspection;
  // The glyph in the face, which the Studio can open. A candidate is not in the face yet.
  const inFace = useMemo(
    () =>
      status === "missing" || status === "candidate"
        ? undefined
        : workspace.glyphForCharacter(face.id, codePoint),
    [codePoint, face.id, project, status, workspace]
  );
  const mark = statusMarkOf(status, glyph?.provenance);
  const cellState = cellStateOf(status, glyph?.provenance);
  const scope = useMemo(() => scopeOf(codePoint), [codePoint]);
  const showInScope = useCallback(() => {
    if (scope) {
      onShowInScope(scope, codePoint);
    }
  }, [codePoint, onShowInScope, scope]);
  const { metrics } = face.description;

  return (
    <div className="ty-coverage-inspector">
      <TitleBlock>
        <TitleBlockItem label="Character" weight={3}>
          {identity ? (identity.name ?? "No name in Unicode") : "Reading"}
        </TitleBlockItem>
        <TitleBlockItem label="Code point">
          {identity?.label ?? ""}
        </TitleBlockItem>
        <TitleBlockItem label="Category" weight={2}>
          {identity?.categoryName ?? ""}
        </TitleBlockItem>
        <TitleBlockItem label="Script" weight={2}>
          {identity ? scriptLabel(identity.script) : ""}
        </TitleBlockItem>
        <TitleBlockItem label="Block" weight={3}>
          {identity ? (identity.block?.name ?? "Outside any block") : ""}
        </TitleBlockItem>
      </TitleBlock>
      {glyph ? (
        <GlyphFigure
          glyph={glyph}
          metrics={metrics}
          state={cellState === "missing" ? "source" : cellState}
          title={`Outline of ${glyph.identity.toLowerCase()} ${glyph.name}`}
        />
      ) : (
        <div className="ty-coverage-gap">
          <Tofu size={60} />
        </div>
      )}
      <Mark kind={mark.kind}>{mark.text}</Mark>
      {glyph?.provenance ? <p>{describeProvenance(glyph.provenance)}</p> : null}
      {glyph ? (
        <DataTable
          caption="The glyph this character maps to"
          columns={FACT_COLUMNS}
          rowKey={factKey}
          rows={glyphFacts(glyph)}
        />
      ) : (
        <p>
          The face has no glyph for this character, so text that uses it shows
          the crossed box.
        </p>
      )}
      {glyph && glyph.sharedWith.length > 0 ? (
        <div className="ty-coverage-shared">
          <h3 className="ty-label">Other characters on this glyph</h3>
          <GlyphGrid label="Other characters on this glyph">
            {glyph.sharedWith.map((other) => (
              <GlyphCell
                codePoint={other}
                key={other}
                onSelect={onSelect}
                state={cellStateOf(
                  coverage.classification.classify(other),
                  coverage.proposalFor(other)?.provenance
                )}
              >
                <GlyphDrawing
                  advance={glyph.advance}
                  metrics={metrics}
                  outline={glyph.outline}
                />
              </GlyphCell>
            ))}
          </GlyphGrid>
        </div>
      ) : null}
      <div className="ty-coverage-offer">
        {scope ? (
          <Button onClick={showInScope}>Show in {scopeName(scope)}</Button>
        ) : null}
        {inFace ? (
          <ButtonLink href={studioHash(face.id, inFace)}>
            Open in the Studio
          </ButtonLink>
        ) : null}
        {status === "candidate" ? (
          <ButtonLink href={studioHash(face.id)}>
            Decide on it in the Studio
          </ButtonLink>
        ) : null}
      </div>
    </div>
  );
}
