import type { TextProps } from "@opentui/react";
import { useTheme } from "~/hooks/use-theme";

/** Body text uses the theme even when the terminal's default foreground differs. */
export function Text({ children, fg, ...props }: TextProps) {
  const theme = useTheme();
  return (
    <text {...props} fg={fg ?? theme.colors.foreground}>
      {children}
    </text>
  );
}
