import type { InputProps } from "@opentui/react";
import { theme } from "./theme";

/** A one-line text field in the theme's colours; props override them. */
export function TextInput(props: InputProps) {
  return (
    <input
      backgroundColor={theme.colors.muted}
      cursorColor={theme.colors.primary}
      focusedBackgroundColor={theme.colors.muted}
      focusedTextColor={theme.colors.foreground}
      textColor={theme.colors.foreground}
      {...props}
    />
  );
}
