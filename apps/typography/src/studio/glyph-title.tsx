import { useEffect, useState } from "react";
import { formatCodePoint } from "~/lib/code-point";
import { type Face, faceStyleName } from "~/typeface/face";
import type { GlyphEntry } from "~/typeface/glyphs";
import { TitleBlock, TitleBlockItem } from "~/ui/content/title-block";
import { characterName } from "~/unicode/names";

/** The Unicode name of a character, once its part of the name data has loaded. */
const useCharacterName = (codePoint: number | undefined) => {
  const [named, setNamed] = useState<{
    readonly codePoint: number;
    readonly name: string | undefined;
  }>();
  useEffect(() => {
    if (codePoint === undefined) {
      return;
    }
    let stale = false;
    characterName(codePoint).then((name) => {
      if (!stale) {
        setNamed({ codePoint, name });
      }
    });
    return () => {
      stale = true;
    };
  }, [codePoint]);
  return named?.codePoint === codePoint ? named?.name : undefined;
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
