import type { TextProps } from "@opentui/react";
import { theme } from "./theme";

/**
 * Body text. Every view paints the theme background, so text takes the theme
 * foreground rather than the terminal default, which may not contrast with it.
 */
export function Text({ children, fg, ...props }: TextProps) {
  return (
    <text {...props} fg={fg ?? theme.colors.foreground}>
      {children}
    </text>
  );
}
