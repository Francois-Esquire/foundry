import type { ExtensionGlyph } from "~/generation/script-extension/extend";
import { formatCodePoint } from "~/lib/code-point";
import { studioHash } from "~/studio/studio-address";
import { addedGlyph } from "~/typeface/changes";
import type { Face } from "~/typeface/face";
import { designMark } from "~/typeface/provenance";
import { DesignFrame } from "~/ui/content/design-frame";
import { ButtonLink } from "~/ui/controls/button";
import { Mark } from "~/ui/symbols/mark";
import { VERDICT_NAMES } from "../evaluation-report";
import { GlyphFigure } from "../glyph-figure";
import { KIND_NAMES } from "./plan-rows";
import type { ShownGlyph } from "./shown-extension";

interface ExtensionGlyphCellProps {
  readonly face: Face;
  /** How the glyph was made and judged. Absent for a run this page did not make. */
  readonly findings?: Pick<ExtensionGlyph, "evaluation" | "madeBy">;
  readonly glyph: ShownGlyph;
  /** True while the extension's revision is applied. */
  readonly inFace: boolean;
  /** For the domain's own sentences, which quote the script. */
  readonly language: string;
}

function Verdict({ evaluation }: Pick<ExtensionGlyph, "evaluation">) {
  if (!evaluation) {
    return <p>Not evaluated. The run kept no evaluation for this glyph.</p>;
  }
  return (
    <p className="ty-extension-verdict" data-verdict={evaluation.verdict}>
      <span
        className="ty-label ty-extension-tag"
        data-on={evaluation.verdict !== "pass"}
      >
        {VERDICT_NAMES[evaluation.verdict]}
      </span>
      <span>
        {evaluation.defects.length === 0
          ? "No defects found."
          : evaluation.defects.map((defect) => defect.detail).join(" ")}
      </span>
    </p>
  );
}

/**
 * One glyph of the extension, drawn large: in the dotted carbon frame of
 * generated work until the whole extension is in the face, with how it was
 * made and how it was judged. It has no decision of its own.
 */
export function ExtensionGlyphCell({
  face,
  glyph,
  findings,
  inFace,
  language,
}: ExtensionGlyphCellProps) {
  const { planned } = glyph;
  const evaluation = findings?.evaluation;
  const characters = glyph.characters.map(formatCodePoint).join(" ");
  // The extension goes into the face whole, so its revision stands for each glyph.
  const mark = designMark(glyph.provenance, inFace ? "accepted" : "proposed");
  return (
    <li
      className="ty-extension-glyph"
      data-glyph={planned.name}
      data-standing={inFace ? "accepted" : "generated"}
    >
      <DesignFrame className="ty-generate-frame" mark={mark}>
        <GlyphFigure
          advance={glyph.advance}
          metrics={face.description.metrics}
          name={`${planned.name}, generated, in carbon`}
          outline={glyph.outline}
        />
      </DesignFrame>
      <div className="ty-extension-glyph-text">
        <h3 className="ty-label">
          <span className="ty-generate-literal">{planned.name}</span>
          {characters ? `, ${characters}` : ", no character"}
        </h3>
        {inFace ? (
          <Mark kind="revisions">
            Accepted, in the face with the whole extension
          </Mark>
        ) : (
          <Mark kind={mark}>Generated, not in the face</Mark>
        )}
        <p>
          {KIND_NAMES[planned.rule.kind]}. Advance {glyph.advance}.
        </p>
        {findings ? (
          <>
            <Verdict evaluation={evaluation} />
            <p lang={language}>
              <span className="ty-label">Made by</span>{" "}
              {findings.madeBy || "Not recorded."}
            </p>
            {(evaluation?.weaknesses ?? []).map((weakness) => (
              <p key={weakness}>
                <span className="ty-label">Known weakness</span> {weakness}
              </p>
            ))}
          </>
        ) : null}
        {inFace ? (
          <ButtonLink href={studioHash(face.id, addedGlyph(glyph.key))}>
            <span>
              Open <span className="ty-generate-literal">{planned.name}</span>{" "}
              in the Studio
            </span>
          </ButtonLink>
        ) : null}
      </div>
    </li>
  );
}
