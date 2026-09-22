// Adapted from termcn.
/* @jsxImportSource @opentui/react */

import type { BorderStyle } from "~/components/ui/types";
import { useTheme } from "~/hooks/use-theme";

type BadgeVariant =
  | "default"
  | "success"
  | "warning"
  | "error"
  | "info"
  | "secondary";

export interface BadgeProps {
  bold?: boolean;
  bordered?: boolean;
  borderStyle?: BorderStyle;
  children: string;
  color?: string;
  paddingX?: number;
  variant?: BadgeVariant;
}

export const Badge = ({
  children,
  variant = "default",
  color,
  bold = false,
  bordered = true,
  borderStyle = "rounded",
  paddingX = 1,
}: BadgeProps) => {
  const theme = useTheme();

  const variantColor =
    color ??
    (() => {
      switch (variant) {
        case "success": {
          return theme.colors.success;
        }
        case "warning": {
          return theme.colors.warning;
        }
        case "error": {
          return theme.colors.error;
        }
        case "info": {
          return theme.colors.info;
        }
        case "secondary": {
          return theme.colors.secondary;
        }
        default: {
          return theme.colors.primary;
        }
      }
    })();

  const textContent = bold ? (
    <text fg={variantColor}>
      <b>{children}</b>
    </text>
  ) : (
    <text fg={variantColor}>{children}</text>
  );

  if (!bordered) {
    return textContent;
  }

  return (
    <box
      borderColor={variantColor}
      borderStyle={borderStyle}
      paddingLeft={paddingX}
      paddingRight={paddingX}
    >
      {textContent}
    </box>
  );
};
