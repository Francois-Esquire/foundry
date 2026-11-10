import { useCallback } from "react";
import type { Proof } from "./proof";
import { SetText } from "./set-text";
import type { BrowserFont } from "./use-proof";

const SAMPLE_SIZE = 20;

/**
 * A sample text in a table, set in the derived font itself, so a script the
 * interface font lacks is never shown in a system font.
 */
export function SampleText({
  browserFont,
  proof,
  text,
}: {
  readonly browserFont: BrowserFont;
  readonly proof: Proof;
  readonly text: string;
}) {
  const has = useCallback(
    (codePoint: number) => proof.characters.has(codePoint),
    [proof]
  );
  return browserFont.status === "loaded" ? (
    <SetText
      family={browserFont.family}
      has={has}
      size={SAMPLE_SIZE}
      text={text}
    />
  ) : (
    <span className="ty-code">
      {[...text]
        .map((character) =>
          (character.codePointAt(0) ?? 0).toString(16).toUpperCase()
        )
        .join(" ")}
    </span>
  );
}
