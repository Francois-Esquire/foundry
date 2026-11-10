import type { ScriptExtension } from "~/generation/script-extension/extend";
import type { Face } from "~/typeface/face";
import { Button } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { Mark } from "~/ui/symbols/mark";
import type { FaceStanding } from "./face-standing";

interface AddPanelProps {
  readonly extension: ScriptExtension;
  readonly face: Face;
  readonly onAdd: () => void;
  /** Why the project refused the extension, when it did. */
  readonly refusal: string | undefined;
  readonly standing: FaceStanding;
}

/**
 * The one action that puts the extension in the face: every glyph and the
 * layout rules, as one revision. There is no way to add part of it.
 */
export function AddPanel({
  extension,
  face,
  onAdd,
  refusal,
  standing,
}: AddPanelProps) {
  const { glyphs, missing } = extension;
  const name = face.description.fullName;
  return (
    <div className="ty-generate-stack">
      <p className="ty-extension-measure">
        The extension goes in whole: {glyphs.length} glyphs and one set of
        layout rules, as one revision. There is no way to add only some of it,
        because the layout rules name every glyph, and a glyph accepted alone
        would carry no rules. Undo, at the top of the page, takes all of it out
        again.
      </p>
      {missing.length > 0 ? (
        <Notice>
          {missing.length} planned{" "}
          {missing.length === 1 ? "glyph was" : "glyphs were"} not made. The
          extension can still be added, without the rules that need{" "}
          {missing.length === 1 ? "it" : "them"}, and its verification will not
          pass.
        </Notice>
      ) : null}
      <div className="ty-generate-actions">
        <Button
          disabled={standing.kind !== "lacking"}
          onClick={onAdd}
          symbol="add"
          variant="solid"
        >
          Add the whole extension to {name}
        </Button>
        {standing.kind === "in-face" ? (
          <Mark kind="revisions">In the face as one revision</Mark>
        ) : (
          <Mark kind="unconfirmed">Generated, not in the face</Mark>
        )}
      </div>
      {standing.kind === "not-offered" ? (
        <Notice>{standing.reason}</Notice>
      ) : null}
      {refusal === undefined ? null : (
        <Notice tone="problem">
          The project refused the extension, and nothing was added. {refusal}
        </Notice>
      )}
    </div>
  );
}
