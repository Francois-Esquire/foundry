import type { CSSProperties } from "react";
import { formatCodePoint } from "~/lib/code-point";
import { Tofu } from "~/ui/content/tofu";
import { coveredRuns } from "./covered-runs";

interface SetTextProps {
  /** The CSS family of the font. The browser must already have loaded it. */
  readonly family: string;
  /** Whether the font holds a character. */
  readonly has: (codePoint: number) => boolean;
  /** Font size in pixels. */
  readonly size: number;
  readonly text: string;
  /** A `font-variation-settings` value, for a variable font. */
  readonly variation?: string;
}

/**
 * Text set in one font and in that font only. A character the font lacks is
 * drawn as the crossed box, so a system fallback font never stands in for it.
 */
export function SetText({ family, has, size, text, variation }: SetTextProps) {
  const style: CSSProperties = {
    fontFamily: `"${family}"`,
    fontSize: size,
    fontVariationSettings: variation,
  };
  let offset = 0;
  return (
    <span className="ty-proof-text" dir="auto" style={style}>
      {coveredRuns(text, has).map((run) => {
        const key = offset;
        if (run.kind === "set") {
          offset += run.text.length;
          return <span key={key}>{run.text}</span>;
        }
        offset += 1;
        return (
          <Tofu
            key={key}
            label={`Missing ${formatCodePoint(run.codePoint)}`}
            size={Math.round(size * 0.7)}
          />
        );
      })}
    </span>
  );
}
