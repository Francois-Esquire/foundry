import "./layout.css";
import type { ReactNode } from "react";
import type { Theme } from "../theme";

interface TapeProps {
  readonly children: ReactNode;
  readonly theme: Theme;
}

/**
 * A ground in a given theme, whatever the theme around it. For showing the
 * same marks on white and on black tape side by side.
 */
export function Tape({ children, theme }: TapeProps) {
  return (
    <div className="ty-tape" data-theme={theme}>
      {children}
    </div>
  );
}
