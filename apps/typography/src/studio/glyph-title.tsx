import { formatCodePoint } from "~/lib/code-point";
import { useSettled } from "~/lib/use-settled";
import { type Face, faceStyleName } from "~/typeface/face";
import type { GlyphEntry } from "~/typeface/glyphs";
import { TitleBlock, TitleBlockItem } from "~/ui/content/title-block";
import { characterName } from "~/unicode/names";

/** A glyph with no character has no name to read. */
const nameOf = async (codePoint: number | undefined) =>
  codePoint === undefined ? undefined : characterName(codePoint);

/** The Unicode name of a character, once its part of the name data has loaded. */
const useCharacterName = (codePoint: number | undefined) => {
  const settled = useSettled(codePoint, nameOf);
  return settled && settled.key === codePoint && "value" in settled
    ? settled.value
    : undefined;
};

interface GlyphTitleProps {
  readonly entry: GlyphEntry;
  readonly face: Face;
  /** The source font's file name. */
  readonly fileName: string;
  readonly head: number;
  readonly pending: boolean;
  readonly revisionCount: number;
}

/** The title block over the drawing: which glyph, which character, which source, which revision. */
export function GlyphTitle({
  entry,
  face,
  fileName,
  head,
  pending,
  revisionCount,
}: GlyphTitleProps) {
  const [character, ...others] = entry.characters;
  const name = useCharacterName(character);
  return (
    <TitleBlock>
      <TitleBlockItem label="Glyph">
        {entry.name}
        {entry.ref.kind === "source"
          ? `, glyph ${entry.ref.glyphId}`
          : ", added in this project"}
      </TitleBlockItem>
      <TitleBlockItem label="Character" weight={2}>
        {character === undefined
          ? "None. This glyph is reached through shaping."
          : `${formatCodePoint(character)} ${name ?? ""}`}
        {others.length > 0
          ? `, and ${others.map(formatCodePoint).join(", ")}`
          : ""}
      </TitleBlockItem>
      <TitleBlockItem label="Source" weight={2}>
        {face.description.familyName}, {faceStyleName(face)}, from {fileName}
      </TitleBlockItem>
      <TitleBlockItem label="Revision">
        {head} of {revisionCount}
        {pending ? ", edit in progress" : ""}
      </TitleBlockItem>
    </TitleBlock>
  );
}
