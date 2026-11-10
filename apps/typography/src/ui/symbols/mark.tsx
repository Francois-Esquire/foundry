import "./symbols.css";
import type { ReactNode } from "react";
import { cx } from "../cx";
import { MARK_DRAWINGS } from "./drawings";

export type MarkKind = keyof typeof MARK_DRAWINGS | "level";
export type CoverageLevel = 0 | 1 | 2 | 3;

const MARK_NAMES: Readonly<Record<MarkKind, string>> = {
  edited: "Edited by hand",
  level: "Coverage level",
  missing: "Missing",
  revisions: "Has revisions",
  source: "In the source font",
  unconfirmed: "Generated or inferred",
};

const LEVEL_DOTS = [4.5, 11, 17.5] as const;

const levelDrawing = (level: CoverageLevel) =>
  LEVEL_DOTS.map((x, index) => (
    <circle
      className={index < level ? "ty-symbol-solid" : undefined}
      cx={x}
      cy="11"
      key={x}
      r="2.5"
    />
  ));

interface MarkProps {
  /** Replaces the mark's standard name, for example "Missing, 3 characters". */
  readonly children?: ReactNode;
  readonly className?: string;
  readonly kind: MarkKind;
  /** How many of the three dots are filled. Only read by the level mark. */
  readonly level?: CoverageLevel;
}

/**
 * One of the six printed marks with its name beside it. Ink marks describe
 * the source font; carbon marks describe work made after it.
 */
export function Mark({ children, className, kind, level = 2 }: MarkProps) {
  const carbon = kind === "edited" || kind === "unconfirmed";
  return (
    <span className={cx("ty-mark", className)} data-kind={kind}>
      <svg
        aria-hidden="true"
        className={cx("ty-symbol", carbon && "ty-mark-drawing-carbon")}
        height="22"
        viewBox="0 0 22 22"
        width="22"
      >
        {kind === "level" ? levelDrawing(level) : MARK_DRAWINGS[kind]}
      </svg>
      <span>{children ?? MARK_NAMES[kind]}</span>
    </span>
  );
}
