// Adapted from termcn.
import type { Theme } from "~/components/ui/types";

export const defaultTheme: Theme = {
  border: {
    color: "#665c54",
    focusColor: "#fabd2f",
    style: "rounded",
  },
  colors: {
    accent: "#8ec07c",
    accentForeground: "#282828",
    background: "#282828",
    border: "#665c54",
    error: "#fb4934",
    errorForeground: "#282828",

    focusRing: "#fabd2f",
    foreground: "#ebdbb2",
    info: "#83a598",
    infoForeground: "#282828",
    muted: "#3c3836",
    mutedForeground: "#a89984",
    primary: "#fabd2f",
    primaryForeground: "#282828",

    secondary: "#d3869b",
    secondaryForeground: "#282828",
    selection: "#504945",
    selectionForeground: "#ebdbb2",
    success: "#b8bb26",

    successForeground: "#282828",
    warning: "#fabd2f",
    warningForeground: "#282828",
  },
  name: "gruvbox-dark",
  spacing: {
    0: 0,
    1: 1,
    2: 2,
    3: 3,
    4: 4,
    6: 6,
    8: 8,
  },
  typography: {
    base: "",
    bold: true,
    lg: "bold",
    sm: "dim",
    xl: "bold",
  },
};
