import { useMemo } from "react";
import { codePointDigits } from "~/lib/code-point";
import { SetText } from "~/ui/content/set-text";
import { splitRuns } from "~/unicode/text-runs";
import type { Proof } from "./proof";
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
  /** The characters the derived font holds. */
  readonly proof: Pick<Proof, "characters">;
  readonly text: string;
}) {
  const runs = useMemo(
    () => splitRuns(text, (codePoint) => proof.characters.has(codePoint)),
    [proof, text]
  );
  return browserFont.status === "loaded" ? (
    <SetText
      className="ty-proof-text"
      family={browserFont.family}
      runs={runs}
      size={SAMPLE_SIZE}
    />
  ) : (
    <span className="ty-code">
      {[...text]
        .map((character) => codePointDigits(character.codePointAt(0) ?? 0))
        .join(" ")}
    </span>
  );
}
