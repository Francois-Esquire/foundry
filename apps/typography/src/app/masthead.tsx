import { type ReactNode, useCallback } from "react";
import { ToggleButton } from "~/ui/controls/toggle-button";
import { setTheme, useTheme } from "~/ui/theme";
import { hashFor } from "./hash-location";

interface MastheadProps {
  /** The state of the open project, supplied by the workspace. */
  readonly status?: ReactNode;
}

export function Masthead({ status }: MastheadProps) {
  const theme = useTheme();
  const chooseTape = useCallback(
    (black: boolean) => setTheme(black ? "black" : "white"),
    []
  );
  return (
    <header className="ty-masthead">
      <a className="ty-display ty-masthead-wordmark" href={hashFor()}>
        Typography
      </a>
      <div className="ty-masthead-status">{status}</div>
      <ToggleButton onPressedChange={chooseTape} pressed={theme === "black"}>
        Black tape
      </ToggleButton>
    </header>
  );
}
