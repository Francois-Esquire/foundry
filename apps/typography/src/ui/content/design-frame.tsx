import "./design-frame.css";
import type { ReactNode } from "react";
import { cx } from "../cx";
import { CornerBrackets } from "./corner-brackets";

interface DesignFrameProps {
  readonly children: ReactNode;
  readonly className?: string;
  /**
   * Where the design inside stands. `edited` is work in the face, solid.
   * `unconfirmed` is generated or inferred work not yet accepted, dotted.
   * `observed` is lettering traced from evidence and not yet accepted, in
   * corner brackets. `none` is a design that is not in the face and is not
   * waiting to be: a hairline.
   */
  readonly mark: "edited" | "none" | "observed" | "unconfirmed";
}

/** The frame around a glyph design drawn large, in the same language as a glyph cell. */
export function DesignFrame({ children, className, mark }: DesignFrameProps) {
  return (
    <div className={cx("ty-design-frame", className)} data-mark={mark}>
      {mark === "observed" ? <CornerBrackets /> : null}
      {children}
    </div>
  );
}
