import "./set-text.css";
import type { CSSProperties } from "react";
import { formatCodePoint } from "~/lib/code-point";
import { cx } from "../cx";
import { Tofu } from "./tofu";

/** The crossed box stands about as tall as a capital. */
const GAP_SHARE = 0.7;

/** A stretch the font can set, or one character it lacks. `start` is where it begins in the text. */
type SetTextRun =
  | { readonly kind: "text"; readonly start: number; readonly text: string }
  | {
      readonly kind: "missing";
      readonly codePoint: number;
      readonly start: number;
    };

interface SetTextProps {
  readonly className?: string;
  /** Left out, the text decides: right to left when it holds such letters. */
  readonly direction?: "ltr" | "rtl";
  /** The CSS family of the font. The browser must already have loaded it. */
  readonly family: string;
  /** A `font-feature-settings` value. */
  readonly features?: string;
  /** BCP 47, so shaping picks the language's own forms. */
  readonly language?: string;
  /** The text, split by the caller into what the font holds and what it lacks. */
  readonly runs: readonly SetTextRun[];
  /** Font size in pixels. */
  readonly size: number;
  /** A `font-variation-settings` value, for a variable font. */
  readonly variation?: string;
}

/**
 * Text set in one font and in that font only. A character the font lacks is
 * drawn as the crossed box, so a system fallback font never stands in for it.
 */
export function SetText({
  className,
  direction,
  family,
  features,
  language,
  runs,
  size,
  variation,
}: SetTextProps) {
  const style: CSSProperties = {
    fontFamily: `"${family}"`,
    fontFeatureSettings: features,
    fontSize: size,
    fontVariationSettings: variation,
  };
  return (
    <span
      className={cx("ty-set-text", className)}
      data-setting="font"
      dir={direction ?? "auto"}
      lang={language}
      style={style}
    >
      {runs.map((run) =>
        run.kind === "text" ? (
          <span key={run.start}>{run.text}</span>
        ) : (
          <Tofu
            key={run.start}
            label={`Missing ${formatCodePoint(run.codePoint)}`}
            size={Math.max(8, Math.round(size * GAP_SHARE))}
          />
        )
      )}
    </span>
  );
}
