import "./layout.css";
import type { CSSProperties, ReactNode } from "react";

interface ColumnsProps {
  /** One element per column. */
  readonly children: ReactNode;
  /**
   * A grid track list such as "1fr 2fr". Left out, the columns are equal.
   * Below 560 pixels the columns stack.
   */
  readonly template?: string;
}

/** Side-by-side columns separated by hairline rules. */
export function Columns({ children, template }: ColumnsProps) {
  return (
    <div className="ty-columns-frame">
      <div
        className="ty-columns"
        style={
          template ? ({ "--ty-columns": template } as CSSProperties) : undefined
        }
      >
        {children}
      </div>
    </div>
  );
}
