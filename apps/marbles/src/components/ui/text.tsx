import type { TextProps } from "@opentui/react";
import { theme } from "./theme";

export function Text({ children, fg, ...props }: TextProps) {
  return (
    <text {...props} fg={fg ?? theme.colors.foreground}>
      {children}
    </text>
  );
}
